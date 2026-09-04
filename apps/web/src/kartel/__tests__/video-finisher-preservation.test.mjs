import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { SaveManager } from "../../core/managers/save-manager.ts";
import { createProjectLoadQueue, projectMediaForHost, requireProjectMedia } from "../video-finisher-media.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test("overlapping restores serialize imports and a failed load does not poison the queue", async () => {
  const queue = createProjectLoadQueue(), gate = deferred();
  const assets = new Set();
  let imported = 0;
  const restore = async () => { if (!assets.has("image")) { await gate.promise; imported++; assets.add("image"); } };
  const first = queue(restore), second = queue(restore);
  await Promise.resolve();
  assert.equal(imported, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(imported, 1);
  await assert.rejects(queue(async () => { throw Error("load failed"); }), /load failed/);
  assert.equal(await queue(async () => "recovered"), "recovered");
});
function editorFor(saveCurrentProject) {
  return { project: { getActive: () => ({}), getIsLoading: () => false, getMigrationState: () => ({ isMigrating: false }), saveCurrentProject } };
}

test("flush waits for an existing write AND an edit queued during it", async () => {
  const first = deferred(), second = deferred();
  let writes = 0, acknowledged = false;
  const manager = new SaveManager({ editor: editorFor(() => (++writes === 1 ? first.promise : second.promise)) });
  const autosave = manager.flush();
  const explicit = manager.flush().then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 2);
  assert.equal(acknowledged, false);
  second.resolve();
  await Promise.all([autosave, explicit]);
  assert.equal(acknowledged, true);
  assert.equal(manager.getIsDirty(), false);
  manager.stop();
});

test("failed persistence rejects explicit save and retains dirty work", async () => {
  let fail = true;
  const manager = new SaveManager({ editor: editorFor(async () => { if (fail) throw Error("QuotaExceededError"); }) });
  await assert.rejects(manager.flush(), /QuotaExceeded/);
  assert.equal(manager.getIsDirty(), true);
  fail = false;
  await manager.flush();
  assert.equal(manager.getIsDirty(), false);
  manager.stop();
});

test("the actual project write propagates storage failure", async () => {
  const source = readFileSync(new URL("../../core/managers/project-manager.ts", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("\tasync saveCurrentProject()"), source.indexOf("\tasync export("));
  const code = ts.transpileModule("class Probe {" + method + "}; exports.Probe=Probe;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const box = { exports: {}, console: { error() {} }, storageService: { saveProject: async () => { throw Error("disk failure"); } }, getProjectDurationFromScenes: () => 5 };
  vm.runInNewContext(code, box);
  const project = new box.exports.Probe();
  project.active = { metadata: { id: "project" } };
  project.editor = { scenes: { getScenes: () => [] } };
  await assert.rejects(project.saveCurrentProject(), /disk failure/);
});

const tracks = (elements) => ({ main: { id: "main", elements }, overlay: [], audio: [] });
test("host save excludes oversized preview cache and preserves the scene", async () => {
  const source = readFileSync(new URL("../video-finisher-bridge.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("\t\tconst save = async"), source.indexOf("\t\tconst insertReplacement = async"));
  const code = ts.transpileModule(body + "\nexports.save=save;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const project = { metadata: { id: "p", thumbnail: "x".repeat(3_000_000) }, scenes: [{ tracks: tracks([]) }] };
  let reply;
  const box = { exports: {}, projectId: "p", OPEN_CUT_COMMIT: "test", identityRef: {}, sourceMediaIdRef: {},
    storageService: { loadProject: async () => ({ project }) }, projectMediaForHost: () => [],
    editor: { save: { flush: async () => {} }, media: { getAssets: () => [] } }, post: (message) => { reply = message; } };
  vm.runInNewContext(code, box);
  await box.exports.save({});
  assert.equal(reply.type, "PROJECT_SAVED");
  assert.equal(reply.payload.document.metadata.thumbnail, undefined);
  assert.equal(reply.payload.document.scenes, project.scenes);
});

test("all referenced imports accompany a save, while missing media blocks it", () => {
  const file = new File(["picture"], "overlay.png", { type: "image/png" });
  const scene = { tracks: tracks([{ mediaId: "source" }, { mediaId: "overlay" }, { mediaId: "overlay" }]) };
  const assets = [{ id: "source", name: "overlay.png", file, url: "blob:source" }, { id: "overlay", name: "overlay.png", file, url: "blob:overlay" }];
  assert.deepEqual(projectMediaForHost({ project: { scenes: [scene] }, assets, sourceId: "source" }), [{ id: "overlay", file }]);
  assert.throws(() => requireProjectMedia({ scenes: [scene], assets: assets.slice(0, 1) }), /Required project media/);
});

test("files recovered from OPFS keep original names and MIME on host save", async () => {
  const stored = new File(["jpeg bytes"], "opaque-media-id");
  const [media] = projectMediaForHost({ project: { scenes: [{ tracks: tracks([{ mediaId: "image" }]) }] },
    assets: [{ id: "image", name: "poster.jpg", file: stored, url: "blob:restored" }], sourceId: null });
  assert.equal(media.file.name, "poster.jpg");
  assert.equal(media.file.type, "image/jpeg");
  assert.equal(await media.file.text(), "jpeg bytes");
});

test("restoring a saved replacement-only timeline never reinserts the original", async () => {
  const source = readFileSync(new URL("../video-finisher-bridge.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("\t\tconst load = async"), source.indexOf("\t\tconst save = async"));
  const code = ts.transpileModule(body + "\nexports.load=load;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scene = { tracks: tracks([{ type: "video", mediaId: "replacement" }]) };
  let inserted = 0;
  const box = { exports: {}, OPEN_CUT_COMMIT: "test", projectId: "p", normalizedProjectDocument: () => ({ scenes: [scene] }),
    applyingRef: { current: false }, storageService: { saveProject: async () => {} }, ensureSource: async () => ({ id: "original", name: "source", type: "video", duration: 15 }),
    sourceMediaIdRef: {}, identityRef: {}, post() {}, sourceLayout: () => [], requireProjectMedia() {},
    mediaTimeToSeconds: ({ time }) => time, toElementDurationTicks: ({ seconds }) => seconds, ZERO_MEDIA_TIME: 0, buildElementFromMedia: (value) => value,
    editor: { media: { getAssets: () => [] }, project: { loadProject: async () => {}, getActive: () => ({ metadata: { name: "source" } }) },
      scenes: { getActiveScene: () => scene }, timeline: { insertElement: () => { inserted++; } }, playback: { getCurrentTime: () => 0 } } };
  vm.runInNewContext(code, box);
  await box.exports.load({ payload: { document: {}, source: { name: "source" } } });
  assert.equal(inserted, 0);
});
