import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createRendererFailureState } from "../../services/renderer/compositor/renderer-failure.ts";
import { createProjectMediaForHost } from "../video-finisher-media.ts";

// Exercise the actual bridge save handler, with its IO replaced; a fatal preview
// must leave this independent checkpoint available before Studio remounts it.
const bridge = readFileSync(new URL("../video-finisher-bridge.tsx", import.meta.url), "utf8");
const saveSource = ts.transpileModule(bridge.slice(bridge.indexOf("const save = async"), bridge.indexOf("const insertReplacement = async")), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const buildSave = new Function("editor", "storageService", "projectId", "identityRef", "post", "projectMediaForHost", "sourceMediaIdRef", "OPEN_CUT_COMMIT", `${saveSource}; return save;`);

test("a fatal preview still checkpoints the newest unsaved edit and all exact referenced media", async () => {
	const failure = createRendererFailureState();
	assert.throws(() => failure.run(() => { throw new WebAssembly.RuntimeError("unreachable"); }));
	const source = { id: "source-v1", name: "source.mp4", file: new File(["source"], "source.mp4", { type: "video/mp4" }), url: "blob:source" };
	const take = { id: "repair-kept", name: "kept.mp4", file: new File(["take"], "kept.mp4", { type: "video/mp4" }), url: "blob:take" };
	const project = { metadata: { id: "project", thumbnail: "disposable" }, scenes: [{ tracks: { main: { elements: [{ mediaId: source.id, duration: 12 }, { mediaId: take.id, duration: 2 }] }, overlay: [], audio: [] } }] };
	let stored = null;
	const posts = [];
	const identity = { nonce: "current-nonce", projectId: "project", revision: 7, operationId: "checkpoint-before-reopen", payload: {} };
	const save = buildSave(
		{ save: { flush: async () => { stored = structuredClone(project); } }, media: { getAssets: () => [source, take] } },
		{ loadProject: async () => { assert.ok(stored, "read must follow flush"); return { project: stored }; } },
		"project", { current: null }, (message) => posts.push(message), createProjectMediaForHost(), { current: source.id }, "a".repeat(40),
	);
	await save(identity);
	assert.equal(posts.length, 1);
	assert.equal(posts[0].type, "PROJECT_SAVED");
	assert.deepEqual(posts[0].identity, identity);
	assert.equal(posts[0].payload.document.scenes[0].tracks.main.elements[1].mediaId, take.id);
	assert.equal(posts[0].payload.document.metadata.thumbnail, undefined);
	assert.equal(posts[0].payload.media.length, 1);
	assert.equal(posts[0].payload.media[0].id, take.id);
	assert.equal(await posts[0].payload.media[0].file.text(), "take");
	assert.ok(failure.getSnapshot(), "checkpointing does not pretend to repair the trapped instance");
});

test("failed checkpoint never supplies a stale project as safe to reopen", async () => {
	const posts = [];
	const save = buildSave(
		{ save: { flush: async () => { throw new Error("storage unavailable"); } } },
		{ loadProject: async () => { throw new Error("must not read an older document"); } },
		"project", { current: null }, (message) => posts.push(message), createProjectMediaForHost(), { current: "source" }, "a".repeat(40),
	);
	await assert.rejects(save({ payload: {} }), /storage unavailable/);
	assert.equal(posts.length, 0);
});

test("a startup renderer failure is reported again with the loaded saved revision", async () => {
	const loadSource = ts.transpileModule(bridge.slice(bridge.indexOf("const load = async"), bridge.indexOf("const save = async")), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	const reportSource = ts.transpileModule(bridge.slice(bridge.indexOf("const renderFailed = () =>"), bridge.indexOf("const unsubscribeRenderFailure =")), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	const build = new Function("editor", "OPEN_CUT_COMMIT", "projectId", "normalizedProjectDocument", "applyingRef", "ensureSource", "sourceMediaIdRef", "identityRef", "post", "sourceLayout", "mediaTimeToSeconds", "VIDEO_FINISHER_EDITOR_CAPABILITIES", "rendererFailure", "bridgeNonce", `${reportSource}\n${loadSource}; return { load, renderFailed };`);
	const failure = createRendererFailureState();
	assert.throws(() => failure.run(() => { throw new WebAssembly.RuntimeError("startup trap"); }));
	const posts = [];
	const identity = { nonce: "current-frame", projectId: "saved-project", revision: 3, operationId: "load-saved", payload: { source: { name: "saved.mp4" } } };
	const { load, renderFailed } = build(
		{ playback: { pause() {}, getCurrentTime: () => 0 }, project: { getActive: () => ({ metadata: { name: "saved.mp4" } }) }, scenes: { getActiveScene: () => ({ tracks: { main: { elements: [{ mediaId: "source-v1" }] }, overlay: [] } }) } },
		"a".repeat(40), "saved-project", () => null, { current: false }, async () => ({ id: "source-v1" }), { current: null }, { current: null },
		(message) => posts.push(message), () => ({}), ({ time }) => time, [], failure, "current-frame",
	);
	renderFailed();
	assert.equal(posts[0].identity.revision, 0, "before a host request the bridge only has its startup identity");
	await load(identity);
	assert.deepEqual(posts.map(({ type, identity }) => [type, identity.revision]), [["RENDER_FAILED", 0], ["PROJECT_LOADED", 3], ["RENDER_FAILED", 3]]);
	assert.equal(posts[2].identity.operationId, "load-saved");
	assert.equal(posts[2].payload.fatal, true);
});

test("real playback ticks stream to Studio while pause, resume and cleanup remain exact", () => {
	const managerSource = readFileSync(new URL("../../core/managers/playback-manager.ts", import.meta.url), "utf8");
	const managerCode = ts.transpileModule(managerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
	const ticksPerSecond = 120_000;
	let now = 1000;
	let sequence = 0;
	const frames = new Map();
	const wasm = {
		ZERO_MEDIA_TIME: 0,
		addMediaTime: ({ a, b }) => a + b,
		clampMediaTime: ({ time, min, max }) => Math.max(min, Math.min(max, time)),
		mediaTimeFromSeconds: ({ seconds }) => Math.round(seconds * ticksPerSecond),
		roundFrameTime: ({ time }) => Math.round(time / 5000) * 5000,
	};
	const PlaybackManager = new Function("require", "exports", "performance", "requestAnimationFrame", "cancelAnimationFrame", `${managerCode}; return exports.PlaybackManager;`)(
		() => wasm, {}, { now: () => now }, (callback) => { const id = ++sequence; frames.set(id, callback); return id; }, (id) => frames.delete(id),
	);
	const editor = { project: { getActive: () => ({ settings: { fps: { numerator: 24, denominator: 1 } } }) },
		timeline: { getTotalDuration: () => 15 * ticksPerSecond, subscribe: () => () => {} },
		scenes: { getActiveScene: () => ({ tracks: { main: { elements: [] } } }), subscribe: () => () => {} }, selection: { subscribe: () => () => {} } };
	editor.playback = new PlaybackManager(editor);
	const posts = [];
	const playheadSource = ts.transpileModule(bridge.slice(bridge.indexOf("let lastPlayheadPost ="), bridge.indexOf('window.addEventListener("message", onMessage)')), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	const subscriptionsStart = bridge.indexOf("const unsubscribers = [");
	const subscriptionsSource = bridge.slice(subscriptionsStart, bridge.indexOf("];", subscriptionsStart) + 2);
	const cleanup = new Function("editor", "identityRef", "sourceMediaIdRef", "post", "mediaTimeToSeconds", "breakdownSourceAtTimeline", "Date", "changed", "selected", `${playheadSource}\n${subscriptionsSource}; return () => unsubscribers.forEach(unsubscribe => unsubscribe());`)(
		editor, { current: { nonce: "current-frame", projectId: "saved-project", revision: 3, operationId: "load-saved" } }, { current: "source" },
		(message) => posts.push(message), ({ time }) => time / ticksPerSecond, () => null, { now: () => now }, () => {}, () => {},
	);
	const tick = (at) => { now = at; const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); };
	editor.playback.play();
	tick(1250);
	assert.equal(posts.length, 2, "the actual RAF update channel reaches the bridge without a seek or pause");
	assert.equal(posts[1].type, "PLAYHEAD_CHANGED");
	assert.equal(posts[1].identity.revision, 3);
	assert.equal(posts[1].payload.seconds, 0.25);
	tick(1400);
	assert.equal(posts.length, 2, "continuous ticks stay bounded by the existing 200 ms throttle");
	tick(1500);
	assert.equal(posts[2].payload.seconds, 0.5);
	editor.playback.pause();
	assert.equal(posts.at(-1).payload.playing, false, "pausing at the last posted frame still changes Studio's transport state");
	editor.playback.play();
	assert.equal(posts.at(-1).payload.playing, true, "a prompt resume is never hidden by the tick throttle");
	cleanup();
	const count = posts.length;
	tick(1750);
	editor.playback.pause();
	assert.equal(posts.length, count, "cleanup removes both the update and discrete playback listeners");
});
