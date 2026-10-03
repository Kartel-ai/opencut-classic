import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { scalePreviewFrame, supportsScaledPreview } from "@/preview/resolution";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
};

// The WASM compositor owns one output canvas. Preview, snapshot and export must
// never race while resolving frames or changing its dimensions/textures.
let renderTail: Promise<unknown> = Promise.resolve();

export class CanvasRenderer {
	width: number;
	height: number;
	fps: FrameRate;
	private previewSize: { width: number; height: number } | null = null;
	previewDecodeSize: number | undefined;

	constructor({ width, height, fps }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;
	}

	getOutputCanvas(): HTMLCanvasElement {
		// Accessing the canvas must not resize pixels a different queued consumer
		// is reading. Every render applies its size while holding the render lock.
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
			resize: false,
		});
		return wasmCompositor.getCanvas();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;
	}

	setPreviewSize(size: { width: number; height: number }): boolean {
		if (
			this.previewSize?.width === size.width &&
			this.previewSize?.height === size.height
		)
			return false;
		this.previewSize = size;
		return true;
	}

	async render({
		node,
		time,
		onRendered,
	}: {
		node: AnyBaseNode;
		time: number;
		onRendered?: () => void | Promise<void>;
	}) {
		const current = renderTail.then(async () => {
			await this.renderFrame({ node, time });
			// CanvasSource.add and snapshots must read the shared canvas before the
			// next renderer is allowed to resize or replace its pixels.
			await onRendered?.();
		});
		renderTail = current.catch(() => {});
		await current;
	}

	private async renderFrame({
		node,
		time,
	}: {
		node: AnyBaseNode;
		time: number;
	}) {
		const size =
			this.previewSize && supportsScaledPreview(node)
				? this.previewSize
				: { width: this.width, height: this.height };
		this.previewDecodeSize =
			size.width < this.width || size.height < this.height
				? Math.max(size.width, size.height)
				: undefined;
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		wasmCompositor.ensureInitialized({
			width: size.width,
			height: size.height,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(scalePreviewFrame({ frame, ...size })),
		});
		onRenderPerfFrameComplete();
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		await this.render({
			node,
			time,
			onRendered: () => {
				const ctx = targetCanvas.getContext("2d");
				if (!ctx) {
					throw new Error("Failed to get target canvas context");
				}

				measureSpanSync({
					name: "drawImage",
					fn: () =>
						ctx.drawImage(
							wasmCompositor.getCanvas(),
							0,
							0,
							targetCanvas.width,
							targetCanvas.height,
						),
				});
			},
		});
	}
}
