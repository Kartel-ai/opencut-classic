import test from "node:test";
import assert from "node:assert/strict";
import { soundtrackTracks } from "../video-finisher-soundtrack.ts";

test("Keep sound preserves original picture and tracks in an undoable snapshot", () => {
  const tracks = { main: { id: "picture", name: "Video", type: "video", muted: false, hidden: false, elements: [{id:"source",type:"video",mediaId:"original-video",startTime:0,duration:15,trimStart:0,trimEnd:0,playbackRate:1}] }, overlay: [], audio: [{ id: "old", type: "audio", name: "Original audio", muted: false, elements: [{id:"dialogue",type:"audio",mediaId:"original-dialogue",startTime:0,duration:15,volume:0.8}] }] };
  const original = structuredClone(tracks);
  const element = { id: "new", type: "audio", mediaId: "kartel-repair-sound-1" };
  const result = soundtrackTracks({ tracks, element, trackId: "new-track" });
  assert.deepEqual(tracks, original);
  assert.deepEqual(result.main.elements, original.main.elements);
  assert.equal(result.main.muted, true);
  assert.deepEqual(result.audio[0].elements, original.audio[0].elements);
  assert.equal(result.audio[0].muted, true);
  assert.equal(result.audio[1].muted, false);
  assert.equal(result.audio[1].elements[0], element);
  assert.equal(soundtrackTracks({ tracks: result, element, trackId: "another-track" }), result);
  assert.equal(original.main.muted, false);
});
test("Solo cannot be silently replaced", () => {
  const tracks = { main: { id: "picture", type: "video", muted: false, elements: [], kartelSolo: { selected: true, originalMuted: false } }, audio: [], overlay: [] };
  assert.throws(() => soundtrackTracks({ tracks, element: { type: "audio" }, trackId: "new" }), /Turn Solo off/);
});
