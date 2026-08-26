import { mock } from "bun:test";
import { Canvas } from "@napi-rs/canvas";
import * as wasmBindings from "../node_modules/opencut-wasm/opencut_wasm_bg.js";

Object.defineProperty(globalThis, "OffscreenCanvas", {
	configurable: true,
	value: Canvas,
});

const wasmBytes = await Bun.file(
	new URL(
		"../node_modules/opencut-wasm/opencut_wasm_bg.wasm",
		import.meta.url,
	),
).arrayBuffer();

const { instance } = await WebAssembly.instantiate(wasmBytes, {
	"./opencut_wasm_bg.js": wasmBindings,
});

wasmBindings.__wbg_set_wasm(instance.exports);

const start = instance.exports.__wbindgen_start;
if (typeof start === "function") {
	start();
}

mock.module("opencut-wasm", () => wasmBindings);
