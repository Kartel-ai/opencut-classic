import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createRendererFailureState, RENDERER_RECOVERY_MESSAGE } from "../renderer-failure.ts";

test("a trapped compositor is called once and stays blocked until a fresh instance", () => {
	const state = createRendererFailureState();
	let calls = 0, notifications = 0;
	state.subscribe(() => { notifications++; });
	const panic = new WebAssembly.RuntimeError("unreachable: RefCell already borrowed");
	const render = () => state.run(() => { calls++; throw panic; });
	assert.throws(render, (error) => error === panic);
	for (let frame = 0; frame < 60; frame++) assert.throws(render, /Reopen the editor/);
	assert.equal(calls, 1);
	assert.equal(notifications, 1);
	assert.deepEqual(state.getSnapshot(), { fatal: true, message: RENDERER_RECOVERY_MESSAGE });
	const fresh = createRendererFailureState();
	assert.equal(fresh.run(() => "painted"), "painted");
	assert.equal(fresh.getSnapshot(), null);
});

test("actual compositor wrappers stop GPU calls after resize traps", async () => {
	const failureURL = new URL("../renderer-failure.ts", import.meta.url).href;
	let code = ts.transpileModule(readFileSync(new URL("../wasm-compositor.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
	code = code.replace(/import\s*\{[\s\S]*?\}\s*from\s*"opencut-wasm";/, `const {getCompositorCanvas, getLastFrameProfile, initCompositor, releaseTexture, renderFrame, resizeCompositor, uploadTexture} = globalThis.__compositorTestWasm;`)
		.replace(/import\s*\{[\s\S]*?\}\s*from\s*"@\/diagnostics\/render-perf";/, "const incrementCounter = () => {}; const isRenderPerfEnabled = () => false;")
		.replace('from "./renderer-failure"', `from ${JSON.stringify(failureURL)}`);
	let resizeCalls = 0, renderCalls = 0;
	// This isolated module imports its own failure latch, so it cannot poison the other test.
	const global = globalThis;
	global.__compositorTestWasm = {
		getCompositorCanvas: () => ({}), initCompositor: () => {},
		resizeCompositor: () => { resizeCalls++; throw new WebAssembly.RuntimeError("unreachable"); },
		renderFrame: () => { renderCalls++; }, releaseTexture: () => {}, uploadTexture: () => {},
	};
	try {
		const { wasmCompositor } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
		wasmCompositor.ensureInitialized({ width: 1920, height: 1080 });
		assert.throws(() => wasmCompositor.ensureInitialized({ width: 960, height: 540 }), /unreachable/);
		assert.throws(() => wasmCompositor.ensureInitialized({ width: 960, height: 540 }), /Reopen/);
		assert.throws(() => wasmCompositor.render({}), /Reopen/);
		assert.equal(resizeCalls, 1);
		assert.equal(renderCalls, 0);
	} finally { delete global.__compositorTestWasm; }
});
