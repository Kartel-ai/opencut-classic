import test from "node:test";
import assert from "node:assert/strict";
import { canJoinPieces, joinedPiece } from "../video-finisher-join.ts";

// A 10 s source clip at 120,000 ticks a second, split at 4 s the way OpenCut's split does it.
const T = 120_000;
const clip = { id: "a", type: "video", name: "Shot 4", mediaId: "source", startTime: 2 * T, duration: 10 * T, trimStart: 1 * T, trimEnd: 3 * T, sourceDuration: 14 * T, params: { muted: true } };
const split = (element, at, rate = 1) => [
	{ ...element, duration: at, trimEnd: element.trimEnd + (element.duration - at) * rate },
	{ ...element, id: "b", name: "Shot 4 (right)", startTime: element.startTime + at, duration: element.duration - at, trimStart: element.trimStart + at * rate },
];

test("two pieces a split made join back into the original clip", () => {
	const [left, right] = split(clip, 4 * T);
	assert.equal(canJoinPieces({ left, right }), true);
	assert.deepEqual(joinedPiece({ left, right }), { ...clip, name: "Shot 4" });
	const [slowLeft, slowRight] = split({ ...clip, retime: { rate: 1.1 } }, 4 * T, 1.1);
	assert.equal(canJoinPieces({ left: slowLeft, right: slowRight }), true);
});

test("pieces that are not one split apart stay separate", () => {
	const [left, right] = split(clip, 4 * T);
	assert.equal(canJoinPieces({ left, right: { ...right, startTime: right.startTime + T } }), false, "a gap on the timeline");
	assert.equal(canJoinPieces({ left, right: { ...right, trimStart: right.trimStart + T } }), false, "a jump in the source");
	assert.equal(canJoinPieces({ left, right: { ...right, mediaId: "take" } }), false);
	assert.equal(canJoinPieces({ left, right: { ...right, params: { muted: false } } }), false);
	assert.equal(canJoinPieces({ left, right: { ...right, animations: { opacity: {} } } }), false);
	assert.equal(canJoinPieces({ left, right: { ...right, retime: { rate: 1.1 } } }), false);
});
