import test from "node:test";
import assert from "node:assert/strict";
import {
	VIDEO_FINISHER_EDITOR_CAPABILITIES, normalizedClipRange, normalizedTakeFit, takeFitGeometrySeconds,
} from "../video-finisher-take-fit.ts";

test("the editor advertises take fits and clip export", () => {
	assert.deepEqual([...VIDEO_FINISHER_EDITOR_CAPABILITIES], ["take-fit", "clip-export"]);
});

test("a fit is optional, and a sent fit must stay within a small retime", () => {
	assert.equal(normalizedTakeFit({ value: undefined, targetSeconds: 2.5 }), undefined);
	assert.deepEqual(normalizedTakeFit({ value: { sourceStartSeconds: 0.5, sourceEndSeconds: 3 }, targetSeconds: 2.5 }), { sourceStartSeconds: 0.5, sourceEndSeconds: 3 });
	assert.equal(normalizedTakeFit({ value: { sourceStartSeconds: 0, sourceEndSeconds: 4 }, targetSeconds: 2.5 }), null);
	assert.equal(normalizedTakeFit({ value: { sourceStartSeconds: 3, sourceEndSeconds: 1 }, targetSeconds: 2.5 }), null);
	assert.equal(normalizedTakeFit({ value: { sourceStartSeconds: -1, sourceEndSeconds: 1.5 }, targetSeconds: 2.5 }), null);
	assert.equal(normalizedTakeFit({ value: "0.5-3", targetSeconds: 2.5 }), null);
});

test("a window of a longer take fills the shot at real speed or a small retime", () => {
	assert.deepEqual(takeFitGeometrySeconds({ fit: { sourceStartSeconds: 0.5, sourceEndSeconds: 3 }, targetSeconds: 2.5, sourceDurationSeconds: 4 }), { trimStartSeconds: 0.5, playbackRate: 1, trimEndSeconds: 1 });
	const retimed = takeFitGeometrySeconds({ fit: { sourceStartSeconds: 0.5, sourceEndSeconds: 3.2 }, targetSeconds: 2.5, sourceDurationSeconds: 4 });
	assert.equal(retimed.playbackRate, 1.08);
	assert.ok(Math.abs(retimed.trimEndSeconds - 0.8) < 1e-9);
	assert.throws(() => takeFitGeometrySeconds({ fit: { sourceStartSeconds: 0.5, sourceEndSeconds: 3 }, targetSeconds: 2.5, sourceDurationSeconds: 2.8 }), /shorter/);
});

test("a clip stays inside the source and between half a second and fifteen", () => {
	assert.deepEqual(normalizedClipRange({ value: { sourceStartSeconds: 3.4, sourceEndSeconds: 6.9 }, sourceDurationSeconds: 15.04 }), { sourceStartSeconds: 3.4, sourceEndSeconds: 6.9 });
	assert.equal(normalizedClipRange({ value: { sourceStartSeconds: 14, sourceEndSeconds: 16 }, sourceDurationSeconds: 15.04 }), null);
	assert.equal(normalizedClipRange({ value: { sourceStartSeconds: 1, sourceEndSeconds: 1.2 }, sourceDurationSeconds: 15.04 }), null);
	assert.equal(normalizedClipRange({ value: { sourceStartSeconds: 0, sourceEndSeconds: 16 }, sourceDurationSeconds: 30 }), null);
});

test("a clip is scaled so its short edge is at most the bound, keeping the aspect", async () => {
	const { clipOutputSize } = await import("../video-finisher-take-fit.ts");
	assert.deepEqual(clipOutputSize({ width: 1080, height: 1350, maxShortEdge: 720 }), { width: 720, height: 900 });
	assert.deepEqual(clipOutputSize({ width: 1920, height: 1080, maxShortEdge: 720 }), { width: 1280, height: 720 });
	assert.equal(clipOutputSize({ width: 544, height: 680, maxShortEdge: 720 }), null);
	assert.equal(clipOutputSize({ width: 1080, height: 1350, maxShortEdge: 0 }), null);
});
