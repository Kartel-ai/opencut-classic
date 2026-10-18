import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Execute the production normalizer, coordinate helpers and SELECT_RANGE handler with a
// seconds-only MediaTime adapter. No mounted editor, media operation, network or provider.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const bridge = read("../video-finisher-bridge.tsx");
function declaration(name) {
  const start = bridge.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function ${name}`);
  return bridge.slice(start, bridge.indexOf("\n}", start) + 2);
}
const strip = (code) => stripTypeScriptTypes(code, { mode: "strip" }).replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
const mediaTimeToSeconds = ({ time }) => time;
const mediaTimeFromSeconds = ({ seconds }) => seconds;
const addMediaTime = ({ a, b }) => a + b;
const dependencies = ["isRecord", "breakdownSourceRange", "normalizedRangeSelection", "rangeSelectionTimelineSeconds", "selectionCoordinates"].map(declaration).join("\n");
const helpers = new Function("mediaTimeToSeconds", "addMediaTime", strip(read("../../retime/rate.ts") + "\n" + read("../../retime/resolve.ts") + "\n" + dependencies) + ";return { normalizedRangeSelection, rangeSelectionTimelineSeconds, breakdownSourceRange, selectionCoordinates }; ")(mediaTimeToSeconds, addMediaTime);
const marker = "const selectRange = ", start = bridge.indexOf(marker) + marker.length;
assert.ok(start >= marker.length);
const handler = strip(bridge.slice(start, bridge.indexOf("\n\t\t};", start) + 5));

const piece = (rate, overrides = {}) => ({ id: "piece", type: "video", mediaId: "original", startTime: 20, duration: 4, trimStart: 6, retime: { rate }, ...overrides });
function harness(element) {
  const writes = [], reply = [];
  const dependencies = { ...helpers, mediaTimeToSeconds, mediaTimeFromSeconds, addMediaTime, sourceMediaIdRef: { current: "original" }, identityRef: { current: null }, post: (event) => reply.push(event),
    editor: { scenes: { getActiveScene: () => ({ tracks: { overlay: [], main: { id: "main", elements: [element] }, audio: [] } }) },
      playback: { pause: () => writes.push("pause"), seek: ({ time }) => writes.push({ seek: time }) }, selection: { setSelectedElements: (selection) => writes.push(selection) } } };
  return { select: new Function(...Object.keys(dependencies), `return ${handler}`)(...Object.values(dependencies)), writes, reply };
}

for (const rate of [0.5, 0.85, 1, 1.15, 2]) test(`production SELECT_RANGE handles physical source and legacy offset clocks at ${rate}x`, async () => {
  const physical = 6 + 2 * rate;
  for (const payload of [{ sourceSeconds: physical, sourceClock: "physical" }, { clipId: "piece", sourceSeconds: physical, sourceClock: "physical" }, { sourceSeconds: 8, clipId: "piece" }]) {
    const h = harness(piece(rate));
    await h.select({ payload });
    assert.ok(Math.abs(h.writes.find((write) => write?.seek !== undefined).seek - 22) < 1e-10);
    assert.equal(h.reply[0].type, "RANGE_SELECTED");
  }
  const oldHost = harness(piece(rate));
  await oldHost.select({ payload: { sourceSeconds: physical, clipId: "piece" } });
  assert.ok(Math.abs(oldHost.writes.find((write) => write?.seek !== undefined).seek - (20 + physical - 6)) < 1e-10, "unmarked requests preserve old host behavior through an editor-first rollout");
});

test("physical source selection guards clip identity, boundaries and unknown markers before any write", async () => {
  for (const payload of [
    { sourceSeconds: 6, sourceClock: "timeline" }, { sourceSeconds: 6, sourceClock: null }, { clipId: "piece", sourceClock: "physical" },
    ...["", 2, "x".repeat(161)].map((clipId) => ({ clipId, sourceSeconds: 10, sourceClock: "physical" })),
    { clipId: "piece", sourceSeconds: 5, sourceClock: "physical" }, { clipId: "piece", sourceSeconds: 14, sourceClock: "physical" },
    { clipId: "piece", sourceSeconds: NaN, sourceClock: "physical" }, { clipId: "missing", sourceSeconds: 10, sourceClock: "physical" },
  ]) {
    const h = harness(piece(2));
    await assert.rejects(h.select({ payload }));
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.reply, []);
  }
  const foreign = harness(piece(2, { mediaId: "other-source" }));
  await assert.rejects(foreign.select({ payload: { clipId: "piece", sourceSeconds: 10, sourceClock: "physical" } }), /original source clock/);
  assert.deepEqual(foreign.writes, []);
  const first = harness(piece(2));
  await first.select({ payload: { clipId: "piece", sourceSeconds: 6, sourceClock: "physical" } });
  assert.deepEqual(first.writes[1], { seek: 20 });
  const last = harness(piece(2));
  await last.select({ payload: { clipId: "piece", sourceSeconds: 13.9, sourceClock: "physical" } });
  assert.deepEqual(last.writes[1], { seek: 23.95 });
});
