import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildFrameDescriptor } from "@/services/renderer/compositor/frame-descriptor";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { BlurBackgroundNode } from "@/services/renderer/nodes/blur-background-node";

test("compositor invalidates reused video canvases by decoded frame identity", async () => {
	const child = Bun.spawn({
		cmd: [process.execPath, fileURLToPath(new URL("./compositor-frame-identity.fixture.ts", import.meta.url))],
		stdout: "pipe", stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(stdout).toContain("Decoded frame changes upload");
});

test("video and blurred backdrop descriptors change with decoded pixels on a reused canvas", async () => {
	const renderer = new CanvasRenderer({ width: 2, height: 2, fps: { numerator: 24, denominator: 1 } });
	const source = new OffscreenCanvas(2, 2);
	const node = new VideoNode();
	node.resolved = { source, sourceWidth: 2, sourceHeight: 2, contentVersion: 0,
		localTime: 0, opacity: 1, effectPasses: [],
		transform: { position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotate: 0 } };
	const first = await buildFrameDescriptor({ node, renderer });
	node.resolved.contentVersion = 1 / 24;
	const next = await buildFrameDescriptor({ node, renderer });
	expect(first.textures[0]).toMatchObject({ source, contentVersion: 0 });
	expect(next.textures[0]).toMatchObject({ source, contentVersion: 1 / 24 });
	const backdrop = new BlurBackgroundNode();
	backdrop.resolved = { backdropSource: { source, width: 2, height: 2, contentVersion: 0 }, passes: [] };
	const oldBlur = await buildFrameDescriptor({ node: backdrop, renderer });
	backdrop.resolved.backdropSource.contentVersion = 1 / 24;
	const newBlur = await buildFrameDescriptor({ node: backdrop, renderer });
	const newTexture = newBlur.textures[0];
	if (newTexture?.kind !== "rendered") throw new Error("Expected rendered blur texture");
	expect(oldBlur.textures[0]).not.toMatchObject({ contentHash: newTexture.contentHash });
	expect((await buildFrameDescriptor({ node: backdrop, renderer })).textures[0]).toMatchObject({ contentHash: newTexture.contentHash });
});
