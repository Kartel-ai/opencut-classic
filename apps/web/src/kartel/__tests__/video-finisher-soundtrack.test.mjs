import test from "node:test";
import assert from "node:assert/strict";
import { isKartelEffectsTrack, soundtrackTracks } from "../video-finisher-soundtrack.ts";

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
test("An effects take joins the separated dialogue and music instead of replacing them", () => {
  const audio = (id, mediaId) => ({ id, type: "audio", name: id, muted: false, elements: [{ id: `${id}-el`, type: "audio", mediaId, startTime: 0, duration: 15, volume: 1 }] });
  const tracks = { main: { id: "picture", type: "video", muted: false, elements: [] }, overlay: [], audio: [audio("original", "original-audio"), audio("voice", "kartel-stem-dialogue-1"), audio("music", "kartel-stem-background-1"), audio("old-take", "kartel-repair-old")] };
  const element = { id: "fx", type: "audio", mediaId: "kartel-repair-fx-1" };
  const result = soundtrackTracks({ tracks, element, trackId: "sound-op-1", mix: "effects" });
  assert.equal(result.main.muted, true);
  assert.deepEqual(result.audio.map(track => track.muted), [true, false, false, true, false]);
  const added = result.audio.at(-1);
  assert.equal(added.name, "Effects");
  assert.equal(isKartelEffectsTrack(added), true);
  assert.equal(isKartelEffectsTrack({ id: "sound-op-2", name: "Improved sound" }), false);
  assert.equal(soundtrackTracks({ tracks, element, trackId: "sound-op-1" }).audio.at(-1).name, "Improved sound");
});
