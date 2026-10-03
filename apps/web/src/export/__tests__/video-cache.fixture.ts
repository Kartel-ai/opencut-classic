// Isolate browser decoder doubles from the rest of the Bun test process.
import { mock } from "bun:test";
import assert from "node:assert/strict";

let opened = 0;
let disposed = 0;
let thumbnailPipelines = 0;
let thumbnailSamplesClosed = 0;
let thumbnailCanvases = 0;
const sizes: { width?: number; height?: number }[] = [];
const state: { pendingOpen?: Promise<void> } = {};
class Input {
	private disposed = false;
	constructor() {
		opened++;
	}
	async getPrimaryVideoTrack() {
		await state.pendingOpen;
		return {
			displayWidth: 3840,
			displayHeight: 2160,
			canDecode: async () => true,
		};
	}
	dispose() {
		if (!this.disposed) disposed++;
		this.disposed = true;
	}
}
class CanvasSink {
	// This double preserves the decoder library's positional constructor API.
	// eslint-disable-next-line opencut/prefer-object-params
	constructor(_track: unknown, size: { width?: number; height?: number }) {
		sizes.push(size);
	}
	async *canvases(time: number) {
		yield { timestamp: time, duration: 1, canvas: {} };
	}
}
class VideoSampleSink {
	getSample() {
		throw new Error("Per-frame decoder initialization is forbidden");
	}
	async *samplesAtTimestamps(seconds: number[]) {
		thumbnailPipelines++;
		for (const _time of seconds)
			yield {
				draw() {},
				close() {
					thumbnailSamplesClosed++;
				},
			};
	}
}
mock.module("mediabunny", () => ({
	Input,
	CanvasSink,
	VideoSampleSink,
	ALL_FORMATS: [],
	BlobSource: class {},
}));
const { VideoCache } = await import("@/services/video-cache/service");
const cache = new VideoCache();
const file = new File(["first"], "source.mp4");
await cache.getFrameAt({
	mediaId: "source",
	file,
	time: 0,
	maxSourceSize: 960,
});
await cache.getFrameAt({
	mediaId: "source",
	file,
	time: 0.1,
	maxSourceSize: 960,
});
assert.equal(opened, 1);
assert.equal(sizes[0].width, 960);
assert.equal(sizes[0].height, 540);
await cache.getFrameAt({ mediaId: "source", file, time: 0 });
assert.equal(cache.getStats().totalSinks, 2);
const replacement = new File(["second"], "source.mp4");
await cache.getFrameAt({ mediaId: "source", file: replacement, time: 0 });
assert.equal(disposed, 2);
assert.equal(cache.getStats().totalSinks, 1);
cache.clearAll();
let release: () => void = () => {};
state.pendingOpen = new Promise<void>((resolve) => {
	release = resolve;
});
const opening = cache.getFrameAt({
	mediaId: "source",
	file,
	time: 0,
	maxSourceSize: 960,
});
cache.clearAll();
release();
assert.equal(await opening, null);
assert.equal(cache.getStats().totalSinks, 0);
assert.equal(opened, disposed);
Object.defineProperty(globalThis, "document", {
	value: {
		createElement: () => {
			thumbnailCanvases++;
			return {
				width: 0,
				height: 0,
				getContext: () => ({}),
				toDataURL: () => "data:image/jpeg;base64,test",
			};
		},
	},
});
const { openClipThumbnailDecoder } =
	await import("@/kartel/video-finisher-clip-thumbnail");
const thumbnailDecoder = await openClipThumbnailDecoder(file);
assert.equal(
	(
		await thumbnailDecoder.frames(
			Array.from({ length: 24 }, (_, index) => index),
		)
	).length,
	24,
);
thumbnailDecoder.dispose();
assert.equal(thumbnailPipelines, 1);
assert.equal(thumbnailSamplesClosed, 24);
assert.equal(thumbnailCanvases, 1);
console.log(
	JSON.stringify({
		reusedDecoder: true,
		reducedSize: [960, 540],
		replacementInvalidatedBothSizes: true,
		pendingDecoderDisposed: true,
		thumbnailPipelines,
		thumbnailSamplesClosed,
		thumbnailCanvases,
	}),
);
