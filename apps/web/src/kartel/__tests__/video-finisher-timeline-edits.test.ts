import { describe, expect, test } from "bun:test";
import { VIDEO_FINISHER_HOST_MESSAGE_TYPES } from "../video-finisher-protocol";
import { applyKartelTimelineEdits, kartelStemRole, normalizedTimelineEdits } from "../video-finisher-timeline-edits";
import type { SceneTracks } from "@/timeline/types";

describe("RS-067 timeline edits from Studio", () => {
	test("an active Solo mix refuses edits before touching the timeline", () => {
		const tracks: SceneTracks = { overlay: [], main: { id: "main", name: "Video", type: "video", elements: [], muted: true, hidden: false, kartelSolo: { selected: true, originalMuted: true } }, audio: [] };
		const unexpectedWrite = () => { throw new Error("Solo guard allowed a timeline write"); };
		const editor = { scenes: { getActiveScene: () => ({ tracks }) }, timeline: { updateTracks: unexpectedWrite }, command: { execute: unexpectedWrite, isRippleEnabled: false } };
		expect(() => applyKartelTimelineEdits({ editor, edits: [{ kind: "mute", role: "background", muted: false }] })).toThrow("Turn Solo off");
	});
	test("the host may switch layout and apply or undo edits", () => {
		for (const type of ["SET_LAYOUT", "APPLY_EDITS", "UNDO_EDITS"] as const) {
			expect(VIDEO_FINISHER_HOST_MESSAGE_TYPES).toContain(type);
		}
	});

	test("a valid list passes through with bounded values", () => {
		const edits = normalizedTimelineEdits([
			{ kind: "ripple_delete", startSeconds: 2.65, endSeconds: 3.88 },
			{ kind: "duck", role: "background", db: -9, rampSeconds: 5, regions: [{ startSeconds: 0.3, endSeconds: 2.3 }] },
			{ kind: "level", role: "dialogue", deltaDb: 3 },
			{ kind: "mute", role: "background", muted: true },
			{ kind: "remove_take", mediaIdPrefix: "kartel-repair-repair-1" },
		]);
		expect(edits).not.toBeNull();
		expect(edits?.[1]).toEqual({ kind: "duck", role: "background", db: -9, rampSeconds: 1, regions: [{ startSeconds: 0.3, endSeconds: 2.3 }] });
	});

	test("anything the editor would not run is refused whole", () => {
		expect(normalizedTimelineEdits([])).toBeNull();
		for (const region of [null, undefined, [], 7, "invalid"]) {
			expect(normalizedTimelineEdits([{ kind: "duck", role: "background", db: -9, regions: [region] }])).toBeNull();
		}
		expect(normalizedTimelineEdits([{ kind: "ripple_delete", startSeconds: 2, endSeconds: 2.01 }])).toBeNull();
		expect(normalizedTimelineEdits([{ kind: "duck", role: "dialogue", db: -9, regions: [{ startSeconds: 0, endSeconds: 1 }] }])).toBeNull();
		expect(normalizedTimelineEdits([{ kind: "duck", role: "background", db: 3, regions: [{ startSeconds: 0, endSeconds: 1 }] }])).toBeNull();
		expect(normalizedTimelineEdits([{ kind: "level", role: "original", deltaDb: 3 }])).toBeNull();
		expect(normalizedTimelineEdits([{ kind: "remove_take", mediaIdPrefix: "kartel-stem-dialogue-x" }])).toBeNull();
		expect(normalizedTimelineEdits([{ kind: "mute", role: "background", muted: true }, { kind: "delete_everything" }])).toBeNull();
	});

	test("separated tracks are known by their stem media id", () => {
		expect(kartelStemRole("kartel-stem-dialogue-a-b")).toBe("dialogue");
		expect(kartelStemRole("kartel-stem-background-a-b")).toBe("background");
		expect(kartelStemRole("kartel-repair-x")).toBeNull();
	});
});
