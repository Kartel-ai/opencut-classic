import test from "node:test";
import assert from "node:assert/strict";
import { kartelClipFrameKey, kartelClipFrameSeconds } from "../video-finisher-clip-frame.ts";

test("each piece of a split source is painted with the middle of its own source range", () => {
	assert.equal(kartelClipFrameSeconds({ trimStartSeconds: 0, durationSeconds: 3.4 }), 1.7);
	assert.equal(kartelClipFrameSeconds({ trimStartSeconds: 10.3, durationSeconds: 3.1 }), 11.9);
	assert.equal(kartelClipFrameSeconds({ trimStartSeconds: 4, durationSeconds: 2, rate: 1.1 }), 5.1);
	assert.equal(kartelClipFrameSeconds({ trimStartSeconds: -1, durationSeconds: Number.NaN }), 0);
	assert.notEqual(kartelClipFrameKey({ mediaId: "source", seconds: 1.7 }), kartelClipFrameKey({ mediaId: "source", seconds: 11.9 }));
});
