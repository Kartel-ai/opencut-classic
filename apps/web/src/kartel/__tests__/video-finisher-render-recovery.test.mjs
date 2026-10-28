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
