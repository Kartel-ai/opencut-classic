export interface ThumbnailDecoder {
	frames(seconds: number[]): Promise<Array<string | null>>;
	dispose(): void;
}

type ThumbnailJob = {
	key: string;
	file: File;
	seconds: number;
	listeners: Set<(frame: string | null) => void>;
	decoder?: ThumbnailDecoder;
};

// Only visible subscribers enqueue work. Leaving the viewport or changing a
// trim cancels queued work; a small reader LRU avoids reparsing each split clip.
export class ClipThumbnailQueue {
	private frames = new Map<string, string>();
	private fileIds = new WeakMap<File, number>();
	private nextFileId = 0;
	private jobs = new Map<string, ThumbnailJob>();
	private pending: ThumbnailJob[] = [];
	private decoders = new Map<File, ThumbnailDecoder>();
	private running = false;

	constructor(private open: (file: File) => Promise<ThumbnailDecoder>) {}

	request({
		file,
		seconds,
		signal,
	}: {
		file: File;
		seconds: number;
		signal: AbortSignal;
	}): Promise<string | null> {
		if (signal.aborted) return Promise.resolve(null);
		let fileId = this.fileIds.get(file);
		if (fileId === undefined) {
			fileId = ++this.nextFileId;
			this.fileIds.set(file, fileId);
		}
		const key = `${fileId}@${seconds.toFixed(1)}`;
		const cached = this.frames.get(key);
		if (cached) {
			this.frames.delete(key);
			this.frames.set(key, cached);
			return Promise.resolve(cached);
		}
		let job = this.jobs.get(key);
		if (!job) {
			job = { key, file, seconds, listeners: new Set() };
			this.jobs.set(key, job);
			this.pending.push(job);
		}
		const current = job;
		return new Promise((resolve) => {
			const finish = (frame: string | null) => {
				signal.removeEventListener("abort", cancel);
				current.listeners.delete(finish);
				resolve(frame);
			};
			const cancel = () => {
				finish(null);
				if (current.listeners.size === 0) {
					if (this.jobs.get(key) === current) this.jobs.delete(key);
					this.pending = this.pending.filter((entry) => entry !== current);
					if (
						current.decoder &&
						![...this.jobs.values()].some(
							(entry) =>
								entry.decoder === current.decoder && entry.listeners.size > 0,
						)
					) {
						current.decoder.dispose();
						this.decoders.delete(file);
					}
				}
			};
			current.listeners.add(finish);
			signal.addEventListener("abort", cancel, { once: true });
			queueMicrotask(() => {
				void this.drain();
			});
		});
	}

	private async drain() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.pending.length) {
				const job = this.pending.shift()!;
				if (!job.listeners.size) continue;
				// Sorted visible requests share one codec decoder, including all cuts
				// within one GOP. Bound each batch so another source cannot starve.
				const batch = [job];
				this.pending = this.pending.filter((entry) => {
					if (entry.file === job.file && batch.length < 24) {
						batch.push(entry);
						return false;
					}
					return true;
				});
				batch.sort((a, b) => a.seconds - b.seconds);
				const results = new Map<ThumbnailJob, string | null>();
				try {
					let decoder = this.decoders.get(job.file);
					if (!decoder) decoder = await this.open(job.file);
					const visible = batch.filter((entry) => entry.listeners.size > 0);
					if (!visible.length) {
						decoder.dispose();
						continue;
					}
					this.decoders.delete(job.file);
					this.decoders.set(job.file, decoder);
					while (this.decoders.size > 2) {
						const oldest = this.decoders.keys().next().value!;
						this.decoders.get(oldest)!.dispose();
						this.decoders.delete(oldest);
					}
					for (const entry of visible) entry.decoder = decoder;
					const frames = await decoder.frames(
						visible.map((entry) => entry.seconds),
					);
					visible.forEach((entry, index) => {
						const frame = frames[index] ?? null;
						results.set(entry, frame);
						if (frame && entry.listeners.size) {
							this.frames.set(entry.key, frame);
							if (this.frames.size > 240)
								this.frames.delete(this.frames.keys().next().value!);
						}
					});
				} catch {
					batch.find((entry) => entry.decoder)?.decoder?.dispose();
					this.decoders.delete(job.file);
				} finally {
					for (const entry of batch) {
						if (this.jobs.get(entry.key) === entry) this.jobs.delete(entry.key);
						for (const finish of entry.listeners)
							finish(results.get(entry) ?? null);
					}
				}
			}
		} finally {
			this.running = false;
		}
	}

	dispose() {
		for (const job of this.jobs.values())
			for (const finish of job.listeners) finish(null);
		this.jobs.clear();
		this.pending = [];
		for (const decoder of this.decoders.values()) decoder.dispose();
		this.decoders.clear();
		this.frames.clear();
	}
}
