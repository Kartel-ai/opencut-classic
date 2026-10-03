import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
	canEncodeVideo,
	canEncodeAudio,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { CanvasRenderer } from "./canvas-renderer";
import { createExportByteBudget } from "@/export/byte-budget";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	maxBytes?: number;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

// Fail unsupported mandatory codecs before decoding/mixing the entire timeline.
export async function preflightSceneExport({
	width,
	height,
	format,
	quality,
	requireAudioTrack,
}: {
	width: number;
	height: number;
	format: ExportFormat;
	quality: ExportQuality;
	requireAudioTrack?: boolean;
}) {
	if (
		!(await canEncodeVideo(format === "mp4" ? "avc" : "vp9", {
			width,
			height,
			bitrate: qualityMap[quality],
		}))
	) {
		throw new Error(
			"This browser cannot encode the requested video format and dimensions.",
		);
	}
	if (
		requireAudioTrack &&
		!(await canEncodeAudio(format === "mp4" ? "aac" : "opus", {
			sampleRate: 44100,
			numberOfChannels: 2,
			bitrate: qualityMap[quality],
		}))
	) {
		throw new Error(
			"This browser cannot encode the required audio track. The project remains saved.",
		);
	}
}

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private maxBytes?: number;
	private videoCodec: "h264" | "vp9";
	private audioCodec: "aac" | "opus" | null = null;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		maxBytes,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.videoCodec = format === "webm" ? "vp9" : "h264";
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.maxBytes = maxBytes;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const budget = createExportByteBudget(this.maxBytes);
		const target = new BufferTarget();
		// Mediabunny owns this positional callback API.
		// eslint-disable-next-line opencut/prefer-object-params
		target.onwrite = (_start, end) => {
			budget.writeThrough(end);
			budget.check();
		};
		const output = new Output({
			format: outputFormat,
			target,
		});

		const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
			onEncodedPacket: (packet) => budget.addPacket(packet.byteLength),
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}
			this.audioCodec = audioCodec;

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
				onEncodedPacket: (packet) => budget.addPacket(packet.byteLength),
			});
			output.addAudioTrack(audioSource);
		}

		try {
			await output.start();

			if (audioSource && this.audioBuffer) {
				await audioSource.add(this.audioBuffer);
				audioSource.close();
				budget.check();
			}

			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) {
					await output.cancel();
					this.emit("cancelled");
					return null;
				}

				const timeTicks = i * ticksPerFrame;
				const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
				await this.renderer.render({
					node: rootNode,
					time: timeTicks,
					onRendered: () => videoSource.add(timeSeconds, 1 / fpsFloat),
				});
				budget.check();

				this.emit("progress", i / frameCount);
			}

			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			videoSource.close();
			await output.finalize();
			budget.check();
			this.emit("progress", 1);

			const buffer = output.target.buffer;
			if (!buffer) {
				this.emit("error", new Error("Failed to export video"));
				return null;
			}

			this.emit("complete", buffer);
			return buffer;
		} catch (error) {
			// A size/encoder failure is terminal for this attempt. Close encoder and
			// muxer resources rather than finishing or silently starting a new export.
			try {
				await output.cancel();
			} catch {
				/* Preserve the original failure. */
			}
			throw error;
		}
	}

	getCodecMetadata(): {
		videoCodec: "h264" | "vp9";
		audioCodec: "aac" | "opus" | null;
	} {
		return { videoCodec: this.videoCodec, audioCodec: this.audioCodec };
	}
}
