import test from "node:test";
import assert from "node:assert/strict";
import { kartelLayoutState, kartelPreviewToolbarShown, kartelThemeFromSearch, kartelTimelineShare, kartelTimelineShownFromSearch, kartelTransportHiddenFromSearch, normalizedKartelTheme, normalizedKartelTransport } from "../video-finisher-studio-look.ts";

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

test("the preview drops its toolbar only in the stage layout when Studio is the transport (RS-366)", () => {
	assert.equal(kartelTransportHiddenFromSearch("?kartel_layout=compact&kartel_timeline=hidden&kartel_transport=hidden"), true);
	assert.equal(kartelTransportHiddenFromSearch("?kartel_layout=compact&kartel_timeline=hidden"), false);
	assert.equal(kartelPreviewToolbarShown({ compact: true, timeline: false, transportHidden: true }), false);
	// All panels (full) and the compact timeline have no Studio timeline beside them.
	assert.equal(kartelPreviewToolbarShown({ compact: false, timeline: true, transportHidden: true }), true);
	assert.equal(kartelPreviewToolbarShown({ compact: true, timeline: true, transportHidden: true }), true);
	// An older Studio never asks, so the stage keeps its toolbar.
	assert.equal(kartelPreviewToolbarShown({ compact: true, timeline: false, transportHidden: false }), true);
});

test("TRANSPORT names play, pause or toggle; anything else is refused (RS-366)", () => {
	assert.equal(normalizedKartelTransport("play"), "play");
	assert.equal(normalizedKartelTransport("pause"), "pause");
	assert.equal(normalizedKartelTransport("toggle"), "toggle");
	assert.equal(normalizedKartelTransport("stop"), null);
	assert.equal(normalizedKartelTransport(undefined), null);
});
