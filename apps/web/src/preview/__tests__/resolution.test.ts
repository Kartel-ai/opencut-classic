import { expect, test } from "bun:test";
import {
	playbackPreviewSize,
	scalePreviewFrame,
	supportsScaledPreview,
} from "../resolution";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { EffectLayerNode } from "@/services/renderer/nodes/effect-layer-node";
import type { FrameDescriptor } from "@/services/renderer/compositor/types";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildFrameDescriptor } from "@/services/renderer/compositor/frame-descriptor";
import { VideoNode } from "@/services/renderer/nodes/video-node";

test("4K playback in a 960px preview uses one sixteenth of output pixels, paused inspection stays native", () => {
	const args = {
		width: 3840,
		height: 2160,
		displayWidth: 960,
		displayHeight: 540,
		pixelRatio: 1,
	};
	expect(playbackPreviewSize({ ...args, playing: true })).toEqual({
		width: 960,
		height: 540,
	});
	expect(playbackPreviewSize({ ...args, playing: false })).toEqual({
		width: 3840,
		height: 2160,
	});
	expect(
		playbackPreviewSize({ ...args, pixelRatio: 2, playing: true }),
	).toEqual({ width: 1920, height: 1080 });
});

test("odd-sized video preserves native geometry while uploading reduced texture pixels", async () => {
	const transform = {
		scaleX: 0.5,
		scaleY: -0.5,
		position: { x: 100, y: -100 },
		rotate: 25,
	};
	const node = new VideoNode({
		duration: 1,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform,
		opacity: 1,
		url: "blob:video",
		mediaId: "video",
		file: new File([], "video.mp4"),
	});
	node.resolved = {
		localTime: 0,
		transform,
		opacity: 1,
		effectPasses: [],
		source: new OffscreenCanvas(960, 540),
		sourceWidth: 3839,
		sourceHeight: 2161,
		textureWidth: 960,
		textureHeight: 540,
	};
	const renderer = new CanvasRenderer({
		width: 3840,
		height: 2160,
		fps: { numerator: 30, denominator: 1 },
	});
	const { frame, textures } = await buildFrameDescriptor({
		node: new RootNode({ duration: 1 }).add(node),
		renderer,
	});
	expect(textures[0].width).toBe(960);
	expect(textures[0].height).toBe(540);
	const layer = frame.items[0];
	if (layer.type !== "layer") throw new Error("Expected a video layer");
	expect(layer.transform.width).toBeCloseTo(3839 * (2160 / 2161) * 0.5, 10);
	expect(layer.transform.height).toBe(1080);
	expect(layer.transform.centerX).toBe(2020);
	expect(layer.transform.centerY).toBe(980);
	expect(layer.transform.flipY).toBe(true);
	expect(layer.transform.rotationDegrees).toBe(25);
});

test("scaled presentation keeps native positions and sizes proportional without changing scene data", () => {
	const frame: FrameDescriptor = {
		width: 3840,
		height: 2160,
		clear: { color: [0, 0, 0, 1] },
		items: [
			{
				type: "layer",
				textureId: "video",
				transform: {
					centerX: 2020,
					centerY: 980,
					width: 1920,
					height: 1080,
					rotationDegrees: 25,
					flipX: false,
					flipY: true,
				},
				opacity: 0.7,
				blendMode: "normal",
				effectPassGroups: [],
				mask: null,
			},
		],
	};
	const scaled = scalePreviewFrame({ frame, width: 960, height: 540 });
	expect(scaled.items[0].type === "layer" && scaled.items[0].transform).toEqual(
		{
			centerX: 505,
			centerY: 245,
			width: 480,
			height: 270,
			rotationDegrees: 25,
			flipX: false,
			flipY: true,
		},
	);
	expect(frame.width).toBe(3840);
	const root = new RootNode({ duration: 1 });
	expect(supportsScaledPreview(root)).toBe(true);
	root.add(
		new EffectLayerNode({
			effectType: "blur",
			effectParams: {},
			timeOffset: 0,
			duration: 1,
		}),
	);
	expect(supportsScaledPreview(root)).toBe(false);
});
