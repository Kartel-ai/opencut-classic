// Run in a subprocess so browser codec doubles never replace other tests' modules.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { FrameDescriptor } from "@/services/renderer/compositor/types";

const events: string[] = [];
let encodedFrames = 0;
let cancelled = 0;
let finalized = 0;
let packetBytes = 30;
let containerBytes = 80;
let raster = { width: 0, height: 0 };
class BufferTarget {
	buffer = new ArrayBuffer(80);
	onwrite?: (start: number, end: number) => void;
}
class Output {
	constructor(public options: { target: BufferTarget }) {}
	get target() {
		return this.options.target;
	}
	addVideoTrack() {}
	addAudioTrack() {}
	async start() {}
	async cancel() {
		cancelled++;
	}
	async finalize() {
		finalized++;
		this.target.onwrite?.(0, containerBytes);
	}
}
class CanvasSource {
	// This double preserves Mediabunny's positional constructor API.
	// eslint-disable-next-line opencut/prefer-object-params
	constructor(
		_canvas: unknown,
		private options: {
			onEncodedPacket: (packet: { byteLength: number }) => void;
		},
	) {}
	async add() {
		encodedFrames++;
		this.options.onEncodedPacket({ byteLength: packetBytes });
	}
	close() {}
}
mock.module("mediabunny", () => ({
	Output,
	BufferTarget,
	CanvasSource,
	AudioBufferSource: class {},
	Mp4OutputFormat: class {},
	WebMOutputFormat: class {},
	QUALITY_LOW: 1,
	QUALITY_MEDIUM: 2,
	QUALITY_HIGH: 3,
	QUALITY_VERY_HIGH: 4,
	canEncodeVideo: async () => true,
	canEncodeAudio: async () => true,
}));
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({
	wasmCompositor: {
		ensureInitialized: (size: typeof raster) => {
			raster = size;
		},
		getCanvas: () => ({}),
		syncTextures: () => {},
		render: (frame: FrameDescriptor) => {
			raster = { width: frame.width, height: frame.height };
			events.push("render");
		},
	},
}));
mock.module("@/services/renderer/resolve", () => ({
	resolveRenderTree: async () => {},
}));
mock.module("@/services/renderer/compositor/frame-descriptor", () => ({
	buildFrameDescriptor: async ({ renderer }: { renderer: typeof raster }) => ({
		frame: {
			width: renderer.width,
			height: renderer.height,
			clear: { color: [0, 0, 0, 1] },
			items: [],
		},
		textures: [],
	}),
}));
const { SceneExporter } = await import("@/services/renderer/scene-exporter");
const { CanvasRenderer } = await import("@/services/renderer/canvas-renderer");
const { RootNode } = await import("@/services/renderer/nodes/root-node");
const { TICKS_PER_SECOND } = await import("@/wasm");
const rootNode = new RootNode({ duration: 8 * TICKS_PER_SECOND });
const params = {
	width: 1280,
	height: 720,
	fps: { numerator: 30, denominator: 1 },
	format: "mp4" as const,
	quality: "high" as const,
};
await assert.rejects(
	new SceneExporter({ ...params, maxBytes: 100 }).export({ rootNode }),
	/recovery limit/,
);
assert.equal(encodedFrames, 4);
assert.equal(cancelled, 1);
assert.equal(finalized, 0);

packetBytes = 0;
containerBytes = 101;
await assert.rejects(
	new SceneExporter({ ...params, maxBytes: 100 }).export({ rootNode }),
	/recovery limit/,
);
assert.equal(cancelled, 2);
assert.equal(finalized, 1);
containerBytes = 100;
assert.ok(
	await new SceneExporter({ ...params, maxBytes: 100 }).export({ rootNode }),
);
assert.deepEqual(raster, { width: 1280, height: 720 });

events.length = 0;
const renderer = new CanvasRenderer(params);
let release: () => void = () => {};
const gate = new Promise<void>((resolve) => {
	release = resolve;
});
const first = renderer.render({
	node: rootNode,
	time: 0,
	onRendered: async () => {
		events.push("consume-start");
		await gate;
		events.push("consume-end");
	},
});
const second = renderer.render({ node: rootNode, time: 1 });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(events, ["render", "consume-start"]);
release();
await Promise.all([first, second]);
assert.deepEqual(events, ["render", "consume-start", "consume-end", "render"]);
console.log(
	JSON.stringify({
		framesBeforeCap: 4,
		totalFrames: 240,
		terminalCancels: cancelled,
		canvasConsumptionSerialized: true,
		nativeExport: raster,
	}),
);
