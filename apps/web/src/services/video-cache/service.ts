import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";

interface VideoSinkData {
	sourceWidth: number;
	sourceHeight: number;
	input: Input;
	sink: CanvasSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();
	private sourceFiles = new Map<string, File>();
	private initializingInputs = new Map<string, Input>();

	async getFrameAt({
		mediaId,
		file,
		time,
		maxSourceSize,
	}: {
		mediaId: string;
		file: File;
		time: number;
		maxSourceSize?: number;
	}): Promise<
		(WrappedCanvas & { sourceWidth: number; sourceHeight: number }) | null
	> {
		const sourceId = mediaId;
		if (this.sourceFiles.get(mediaId) !== file) {
			this.clearVideo({ mediaId });
			this.sourceFiles.set(mediaId, file);
		}
		if (maxSourceSize) {
			const previewPrefix = `${mediaId}:preview:`;
			mediaId = `${previewPrefix}${maxSourceSize}`;
			// Keep at most one reduced-resolution decoder per source; native export
			// and paused-inspection decoders have a separate key.
			for (const key of new Set([
				...this.sinks.keys(),
				...this.initializingInputs.keys(),
			])) {
				if (key.startsWith(previewPrefix) && key !== mediaId)
					this.clearSink(key);
			}
		}
		await this.ensureSink({ mediaId, file, maxSourceSize });
		if (this.sourceFiles.get(sourceId) !== file) return null;

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		const generation = (this.seekGenerations.get(mediaId) ?? 0) + 1;
		this.seekGenerations.set(mediaId, generation);

		const previous = this.frameChain.get(mediaId) ?? Promise.resolve();
		const current = previous.then(() => {
			if (this.seekGenerations.get(mediaId) !== generation) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveFrame({ sinkData, time });
		});
		this.frameChain.set(
			mediaId,
			current.catch(() => {}),
		);
		const frame = await current;
		return frame
			? {
					...frame,
					sourceWidth: sinkData.sourceWidth,
					sourceHeight: sinkData.sourceHeight,
				}
			: null;
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
		maxSourceSize,
	}: {
		mediaId: string;
		file: File;
		maxSourceSize?: number;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file, maxSourceSize });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			if (this.initPromises.get(mediaId) === initPromise)
				this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
		maxSourceSize,
	}: {
		mediaId: string;
		file: File;
		maxSourceSize?: number;
	}): Promise<void> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});
		this.initializingInputs.set(mediaId, input);

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (this.initializingInputs.get(mediaId) !== input) return;
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const scale = maxSourceSize
				? Math.min(
						1,
						maxSourceSize /
							Math.max(videoTrack.displayWidth, videoTrack.displayHeight),
					)
				: 1;
			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
				...(scale < 1
					? {
							width: Math.max(1, Math.round(videoTrack.displayWidth * scale)),
							height: Math.max(1, Math.round(videoTrack.displayHeight * scale)),
						}
					: {}),
			});

			this.sinks.set(mediaId, {
				sourceWidth: videoTrack.displayWidth,
				sourceHeight: videoTrack.displayHeight,
				input,
				sink,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
			});
		} catch (error) {
			input.dispose();
			if (this.initializingInputs.get(mediaId) !== input) return;
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		} finally {
			if (this.initializingInputs.get(mediaId) === input)
				this.initializingInputs.delete(mediaId);
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		for (const key of new Set([
			...this.sinks.keys(),
			...this.initializingInputs.keys(),
		])) {
			if (key === mediaId || key.startsWith(`${mediaId}:preview:`))
				this.clearSink(key);
		}
		this.sourceFiles.delete(mediaId);
	}

	private clearSink(mediaId: string): void {
		this.initializingInputs.get(mediaId)?.dispose();
		this.initializingInputs.delete(mediaId);
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
		this.frameChain.delete(mediaId);
		this.seekGenerations.delete(mediaId);
	}

	clearAll(): void {
		for (const key of new Set([
			...this.sinks.keys(),
			...this.initializingInputs.keys(),
		]))
			this.clearSink(key);
		this.sourceFiles.clear();
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
