import type { FrameDescriptor } from "@/services/renderer/compositor/types";
import type { AnyBaseNode } from "@/services/renderer/nodes/base-node";
import { BlurBackgroundNode } from "@/services/renderer/nodes/blur-background-node";
import { EffectLayerNode } from "@/services/renderer/nodes/effect-layer-node";

export function playbackPreviewSize({
	width,
	height,
	displayWidth,
	displayHeight,
	playing,
	pixelRatio = 1,
}: {
	width: number;
	height: number;
	displayWidth: number;
	displayHeight: number;
	playing: boolean;
	pixelRatio?: number;
}) {
	if (!playing || displayWidth <= 0 || displayHeight <= 0)
		return { width, height };
	const density = Math.max(1, Math.min(2, pixelRatio));
	const scale = Math.min(
		1,
		Math.max(
			0.25,
			Math.ceil(
				Math.max(displayWidth / width, displayHeight / height) * density * 4,
			) / 4,
		),
	);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

// Effect kernels and mask feathering use raster-pixel units. Keep those scenes
// native until their individual passes support a separate logical resolution.
export function supportsScaledPreview(node: AnyBaseNode): boolean {
	if (node instanceof BlurBackgroundNode || node instanceof EffectLayerNode)
		return false;
	const params = node.params;
	if (
		params &&
		"effects" in params &&
		Array.isArray(params.effects) &&
		params.effects.some((effect) => effect.enabled)
	)
		return false;
	if (
		params &&
		"masks" in params &&
		Array.isArray(params.masks) &&
		params.masks.length > 0
	)
		return false;
	return node.children.every(supportsScaledPreview);
}

// Scene construction, overlays, hit testing and document state stay in native
// coordinates. Only the final presentation transform changes pixel units.
export function scalePreviewFrame({
	frame,
	width,
	height,
}: {
	frame: FrameDescriptor;
	width: number;
	height: number;
}): FrameDescriptor {
	if (frame.width === width && frame.height === height) return frame;
	const scaleX = width / frame.width;
	const scaleY = height / frame.height;
	return {
		...frame,
		width,
		height,
		items: frame.items.map((item) =>
			item.type === "layer"
				? {
						...item,
						transform: {
							...item.transform,
							centerX: item.transform.centerX * scaleX,
							centerY: item.transform.centerY * scaleY,
							width: item.transform.width * scaleX,
							height: item.transform.height * scaleY,
						},
					}
				: item,
		),
	};
}
