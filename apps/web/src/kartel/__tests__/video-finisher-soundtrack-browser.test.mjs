import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { stripTypeScriptTypes } from "node:module";

// Exercise the real bridge insertion block, soundtrack reducer and snapshot
// command in Chromium. Node fixtures cannot model an uncloneable AudioBuffer.
const source = async (relative) => readFile(new URL(relative, import.meta.url), "utf8");
const browserSource = (text) => stripTypeScriptTypes(text)
  .replace(/^import .*?;\s*/gms, "")
  .replace(/^export /gm, "");

test("successive soundtrack Keeps retain browser buffers and undo history", { timeout: 30_000 }, async () => {
  const bridge = await source("../video-finisher-bridge.tsx");
  const insertion = bridge.match(/const before = [^;]+;\s*const mix = [^;]+;\s*const after = soundtrackTracks\([\s\S]*?editor\.command\.execute\(\{ command: new TracksSnapshotCommand\(\{ before, after \}\) \}\);/)?.[0];
  assert.ok(insertion, "the production soundtrack insertion block is located");
  const reducer = browserSource(await source("../video-finisher-soundtrack.ts"));
  const command = browserSource(await source("../../commands/timeline/tracks-snapshot.ts"));
  const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path && existsSync(path));
  assert.ok(chrome, "Chromium is required; set CHROME_PATH if it is not installed in a standard location");
  const profile = await mkdtemp(join(tmpdir(), "opencut-soundtrack-"));
  let child, socket;
  try {
    child = spawn(chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
    let port;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch {}
      if (port) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(port, "the isolated Chromium starts");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const expression = `(() => {
      const check = (condition, label) => { if (!condition) throw new Error(label); };
      class Command { redo() { return this.execute(); } }
      let currentEditor;
      const EditorCore = { getInstance: () => currentEditor };
      ${reducer}
      ${command}
      const isRecord = value => value !== null && typeof value === "object";
      const keep = (editor, element, operationId, mode) => {
        const activeScene = editor.scenes.getActiveScene();
        const message = { operationId, payload: mode ? { mix: mode } : {} };
        ${insertion}
      };
      const results = [];
      for (const mode of [undefined, "effects"]) {
        const audio = (id, mediaId) => ({ id, type: "audio", mediaId, params: { volume: 0, muted: false }, buffer: new AudioBuffer({ length: 1, sampleRate: 44100 }) });
        const original = { main: { id: "picture", type: "video", muted: false, elements: [{ id: "clip", type: "video", mediaId: "original-version", duration: 5 }] }, overlay: [{ id: "overlay", type: "video", muted: false, elements: [] }], audio: mode ? [{ id: "voice", type: "audio", muted: false, elements: [audio("voice-el", "kartel-stem-dialogue")] }, { id: "music", type: "audio", muted: true, elements: [audio("music-el", "kartel-stem-background")] }] : [] };
        const history = [];
        let tracks = original;
        const editor = { scenes: { getActiveScene: () => ({ tracks }) }, timeline: { updateTracks: value => { tracks = value; } }, command: { execute: ({ command }) => { command.execute(); history.push(command); } } };
        currentEditor = editor;
        const a = audio("a", "kartel-repair-a");
        const b = audio("b", "kartel-repair-b");
        let cloneError;
        try { structuredClone({ buffer: a.buffer }); } catch (error) { cloneError = error.name; }
        check(cloneError === "DataCloneError", "the regression uses a real non-serializable AudioBuffer");
        keep(editor, a, "a", mode);
        const afterA = tracks;
        keep(editor, b, "b", mode);
        const afterB = tracks;
        check(history.length === 2, "two Keeps create two undo steps");
        check(original.main.muted === false && original.overlay[0].muted === false, "original picture mute state is untouched");
        check(original.audio.length === (mode ? 2 : 0), "original audio tracks are untouched");
        check(afterA.audio.at(-1).muted === false && afterA.audio.length === original.audio.length + 1, "A snapshot remains unchanged after B");
        check(afterB.main.elements === original.main.elements && afterB.main.muted === true && afterB.overlay[0].muted === true, "picture identity is preserved and original audio is muted");
        check(afterB.audio.at(-2).muted === true && afterB.audio.at(-1).muted === false, "B replaces audible A");
        check(afterB.audio.at(-2).elements[0].buffer === a.buffer && afterB.audio.at(-1).elements[0].buffer === b.buffer, "A and B retain their exact AudioBuffers");
        check(afterB.audio.at(-2).elements[0].mediaId === a.mediaId && afterB.audio.at(-1).elements[0].mediaId === b.mediaId, "media identity is preserved");
        if (mode) check(afterB.audio[0].muted === false && afterB.audio[1].muted === true && original.audio[0].muted === false && original.audio[1].muted === true, "effects preserve each stem's previous mix state");
        history[1].undo(); check(tracks === afterA && tracks.audio.at(-1).muted === false, "undo B restores exact A snapshot");
        history[0].undo(); check(tracks === original, "undo A restores exact original snapshot");
        history[0].redo(); check(tracks === afterA, "redo A restores its exact snapshot");
        history[1].redo(); check(tracks === afterB && tracks.audio.at(-1).elements[0].buffer === b.buffer, "redo B restores exact B snapshot and buffer");
        results.push({ mode: mode || "whole mix", cloneError, undoSteps: history.length, exactBuffers: true, originalPreserved: true, undoRedo: true });
      }
      return results;
    })()`;
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("browser regression timed out")), 10_000);
      socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id !== 1) return; clearTimeout(timeout); resolve(message.result); });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    assert.equal(result.result.value.length, 2);
    console.log(JSON.stringify(result.result.value));
  } finally {
    socket?.close();
    if (child && child.exitCode === null) {
      let deadline;
      try {
        const stopped = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await Promise.race([stopped, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("owned Chromium did not exit")), 5_000); })]);
      } finally { clearTimeout(deadline); }
    }
    const resolvedProfile = resolve(profile);
    assert.ok(resolvedProfile.startsWith(`${resolve(tmpdir())}${sep}`) && basename(resolvedProfile).startsWith("opencut-soundtrack-"), "cleanup stays inside the owned temporary profile");
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
