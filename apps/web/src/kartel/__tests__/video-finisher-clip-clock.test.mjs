import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { clipMediaId, clipOutputSize, normalizedClipRange } from "../video-finisher-take-fit.ts";

const source = readFileSync(new URL("../video-finisher-bridge.tsx", import.meta.url), "utf8");
const start = source.indexOf("const exportClip = async (") + "const exportClip = ".length;
const callback = stripTypeScriptTypes(source.slice(start, source.indexOf("\n\t\t};", start) + 4));

async function run({ width = 1280, height = 720, mediaId, valid = true } = {}) {
  let options, reply;
  const context = { File, Date, clipMediaId, clipOutputSize, normalizedClipRange,
    sourceMediaIdRef: { current: "source" },
    editor: { media: { getAssets: () => [{ id: mediaId ?? "source", file: new File(["source"], "source.mp4"), type: "video", duration: 6.048, width, height }] } },
    Input: class { constructor(options) { Object.assign(this, options); } },
    BlobSource: class {}, ALL_FORMATS: [], Mp4OutputFormat: class {}, BufferTarget: class {},
    Output: class { constructor(options) { Object.assign(this, options); } },
    Conversion: { init: async value => { options = value; return { isValid: valid, execute: async () => { value.output.target.buffer = new ArrayBuffer(8); } }; } },
    post: value => { reply = value; },
  };
  vm.runInNewContext(`run = ${callback}`, context);
  await context.run({ payload: { sourceStartSeconds: 1, sourceEndSeconds: 145 / 24, maxShortEdge: 720, ...(mediaId ? { mediaId } : {}) } });
  return { options, reply };
}

test("frame cuts decode even when an H.264 clip needs no resize", async () => {
  const { options, reply } = await run();
  assert.equal(options.video.forceTranscode, true, "packet copying can lose reordered source frames");
  assert.equal(options.video.codec, "avc");
  assert.equal(options.trim.start, 1);
  assert.equal(options.trim.end, 145 / 24);
  assert.equal(options.audio.discard, true);
  assert.equal(options.video.frameRate, undefined, "do not synthesize or drop frames to a guessed rate");
  assert.equal(reply.payload.durationSeconds, 121 / 24);
});

test("kept takes and scaled references use the same frame-preserving path", async () => {
  const { options, reply } = await run({ width: 1920, height: 1080, mediaId: "kartel-repair-existing" });
  assert.equal(options.video.forceTranscode, true);
  assert.equal(options.video.width, 1280);
  assert.equal(options.video.height, 720);
  assert.equal(reply.type, "CLIP_EXPORTED");
});

test("unsupported conversion fails before returning a clip", async () => {
  await assert.rejects(run({ valid: false }), /cannot cut/);
});
