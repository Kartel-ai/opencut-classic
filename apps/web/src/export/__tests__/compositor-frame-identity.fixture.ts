import { mock } from "bun:test";
import assert from "node:assert/strict";

class TestCanvas {}
Object.defineProperty(globalThis, "OffscreenCanvas", { value: TestCanvas });
const uploads: unknown[] = [];
mock.module("opencut-wasm", () => ({
	getCompositorCanvas() {}, getLastFrameProfile() {}, initCompositor() {},
	releaseTexture() {}, renderFrame() {}, resizeCompositor() {},
	uploadTexture(value: unknown) { uploads.push(value); },
}));
const { wasmCompositor } = await import("@/services/renderer/compositor/wasm-compositor");
const source = new OffscreenCanvas(2, 2);
const texture = { kind: "external" as const, id: "video", source, width: 2, height: 2, contentVersion: 0 };
wasmCompositor.syncTextures([texture]);
wasmCompositor.syncTextures([{ ...texture }]);
assert.equal(uploads.length, 1, "same decoded frame remains cached");
wasmCompositor.syncTextures([{ ...texture, contentVersion: 1 / 24 }]);
assert.equal(uploads.length, 2, "a reused canvas carrying the next frame must upload");
wasmCompositor.syncTextures([{ ...texture, contentVersion: 0 }]);
assert.equal(uploads.length, 3, "backward seeks must restore their frame pixels");
const image = { ...texture, id: "still", contentVersion: undefined };
wasmCompositor.syncTextures([image]);
wasmCompositor.syncTextures([{ ...image }]);
assert.equal(uploads.length, 4, "immutable image reference stays cached");
console.log("Decoded frame changes upload; frozen frames and stills retain their cache.");
