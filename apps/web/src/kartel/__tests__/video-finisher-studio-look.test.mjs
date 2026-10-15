import test from "node:test";
import assert from "node:assert/strict";
import { kartelLayoutState, kartelThemeFromSearch, kartelTimelineShare, kartelTimelineShownFromSearch, normalizedKartelTheme } from "../video-finisher-studio-look.ts";

test("the embed takes Studio's theme only when Studio names light or dark", () => {
	assert.equal(kartelThemeFromSearch("?kartel_nonce=n&kartel_theme=light"), "light");
	assert.equal(kartelThemeFromSearch("?kartel_theme=dark"), "dark");
	assert.equal(kartelThemeFromSearch("?kartel_theme=sepia"), null);
	assert.equal(kartelThemeFromSearch("?kartel_layout=compact"), null);
	assert.equal(normalizedKartelTheme("light"), "light");
	assert.equal(normalizedKartelTheme(undefined), null);
});

test("the compact timeline is as tall as its lanes, from the frame's height now", () => {
	// One video lane (65px + 6px gap) in a 908px frame: lanes and chrome are 22.4%.
	assert.equal(Math.round(kartelTimelineShare({ lanePixels: 71, frameHeight: 908 }) * 10) / 10, 22.4);
	// The same lanes once the frame has grown from 420px: the share follows (62% capped before).
	assert.equal(kartelTimelineShare({ lanePixels: 71, frameHeight: 420 }), 48.333333333333336);
	assert.ok(kartelTimelineShare({ lanePixels: 71, frameHeight: 1023 }) < 26);
	// A short cut never squeezes below 18%; many lanes never take more than 62%.
	assert.equal(kartelTimelineShare({ lanePixels: 10, frameHeight: 2000 }), 18);
	assert.equal(kartelTimelineShare({ lanePixels: 900, frameHeight: 600 }), 62);
	// Before the frame has a height the old 36% default holds.
	assert.equal(kartelTimelineShare({ lanePixels: 71, frameHeight: 0 }), 36);
});

test("the embed opens as the picture alone only when Studio hides the timeline (RS-313)", () => {
	assert.equal(kartelTimelineShownFromSearch("?kartel_layout=compact&kartel_timeline=hidden"), false);
	assert.equal(kartelTimelineShownFromSearch("?kartel_layout=compact"), true);
	assert.equal(kartelTimelineShownFromSearch("?kartel_timeline=shown"), true);
});

test("SET_LAYOUT names stage, compact or full; anything else is refused (RS-313)", () => {
	assert.deepEqual(kartelLayoutState("stage"), { compact: true, timeline: false });
	assert.deepEqual(kartelLayoutState("compact"), { compact: true, timeline: true });
	assert.deepEqual(kartelLayoutState("full"), { compact: false, timeline: true });
	assert.equal(kartelLayoutState("preview"), null);
	assert.equal(kartelLayoutState(undefined), null);
});
