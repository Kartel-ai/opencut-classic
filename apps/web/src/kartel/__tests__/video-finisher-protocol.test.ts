import { describe, expect, test } from "bun:test";
import {
	buildVideoFinisherBridgeMessage,
	isKartelVideoFinisherRoute,
	shouldShowEditorMobileGate,
	shouldShowStandaloneEditorChrome,
	VIDEO_FINISHER_BRIDGE,
	VIDEO_FINISHER_BRIDGE_VERSION,
} from "../video-finisher-protocol";
import {
	KARTEL_MARKER_PREFIX,
	breakdownCutTimelineSeconds,
	breakdownSourceAtTimeline,
	breakdownSourceRange,
	breakdownStemGeometry,
	kartelMarkerBookmarks,
	normalizedBreakdown,
	normalizedMarkers,
	normalizedPreviewRange,
	normalizedRangeSelection,
	normalizedRepairInsertion,
	repairMediaId,
	repairPreviewUpdate,
	sourceFile,
	stemMediaId,
	videoFinisherExportFrameRate,
	videoFinisherSourceLayout,
} from "../video-finisher-bridge";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import type { VideoElement } from "@/timeline/types";

describe("buildVideoFinisherBridgeMessage", () => {
	test("keeps the response type authoritative when the host identity is a complete request", () => {
		const request = {
			bridge: VIDEO_FINISHER_BRIDGE,
			version: VIDEO_FINISHER_BRIDGE_VERSION,
			type: "LOAD_PROJECT" as const,
			nonce: "nonce-1",
			projectId: "project-1",
			revision: 4,
			operationId: "load-1",
			payload: { project: "source" },
		};

		expect(
			buildVideoFinisherBridgeMessage({
				type: "PROJECT_LOADED",
				identity: request,
				payload: { instanceId: "project-1" },
			}),
		).toEqual({
			bridge: VIDEO_FINISHER_BRIDGE,
			version: VIDEO_FINISHER_BRIDGE_VERSION,
			type: "PROJECT_LOADED",
			nonce: "nonce-1",
			projectId: "project-1",
			revision: 4,
			operationId: "load-1",
			payload: { instanceId: "project-1" },
		});
	});
});

describe("isKartelVideoFinisherRoute", () => {
	test("matches only the exact embedded editor route", () => {
		expect(isKartelVideoFinisherRoute("/kartel/editor/project-1")).toBe(true);
		expect(isKartelVideoFinisherRoute("/kartel/editor/project-1/")).toBe(true);
		expect(isKartelVideoFinisherRoute("/editor/project-1")).toBe(false);
		expect(isKartelVideoFinisherRoute("/kartel/editorial/project-1")).toBe(false);
	});

	test("removes standalone editor chrome only from the exact embedded route", () => {
		expect(shouldShowStandaloneEditorChrome("/kartel/editor/project-1")).toBe(false);
		expect(shouldShowStandaloneEditorChrome("/kartel/editor/project-1/")).toBe(false);
		expect(shouldShowStandaloneEditorChrome("/editor/project-1")).toBe(true);
		expect(shouldShowStandaloneEditorChrome("/kartel/editorial/project-1")).toBe(true);
	});

	test("leaves the standalone mobile warning intact but never blocks the governed embed", () => {
		expect(shouldShowEditorMobileGate("/kartel/editor/project-1")).toBe(false);
		expect(shouldShowEditorMobileGate("/kartel/editor/project-1/")).toBe(false);
		expect(shouldShowEditorMobileGate("/editor/project-1")).toBe(true);
		expect(shouldShowEditorMobileGate("/kartel/editorial/project-1")).toBe(true);
	});
});

describe("videoFinisherExportFrameRate", () => {
	test("serializes the editor rational as the scalar Studio receipt contract", () => {
		expect(videoFinisherExportFrameRate({ numerator: 24_000, denominator: 1_001 }))
			.toBe(24_000 / 1_001);
	});
});

describe("normalizedRepairInsertion", () => {
	test("keeps one exact bounded replacement and rejects duration or media-role drift", () => {
		const input = {
      semanticRole: "replacement_voice" as const,
			clipId: "clip-dialogue-1",
			startSeconds: 3.25,
			endSeconds: 4.75,
			candidate: {
				assetId: "asset-1",
				versionId: "version-1",
				name: "replacement.wav",
				src: "https://studio.example/private/replacement.wav",
				mimeType: "audio/wav",
				byteSize: 144044,
				sha256: "a".repeat(64),
				durationSeconds: 1.5,
			},
		};
		expect(normalizedRepairInsertion(input)).toEqual(input);
		// A synthesized voice line arrives from the provider as MP3.
		const spoken = { ...input, candidate: { ...input.candidate, name: "line.mp3", mimeType: "audio/mpeg" } };
		expect(normalizedRepairInsertion(spoken)).toEqual(spoken);
		expect(normalizedRepairInsertion({ ...input, candidate: { ...input.candidate, mimeType: "video/mp4" } })).toBeNull();
		expect(normalizedRepairInsertion({
			...input,
			candidate: { ...input.candidate, durationSeconds: 1.0 },
		})).toBeNull();
		expect(normalizedRepairInsertion({
			...input,
			candidate: { ...input.candidate, mimeType: "video/mp4" },
		})).toBeNull();
	});
});

describe("repairMediaId", () => {
	test("binds insertion and observation to the same bounded operation identity", () => {
		expect(repairMediaId("repair-operation-1")).toBe("kartel-repair-repair-operation-1");
		expect(repairMediaId("x".repeat(300))).toHaveLength(240);
	});
});

describe("sourceFile", () => {
	test("accepts one exact transferred MP4 without a signed URL and rejects checksum drift", async () => {
		const bytes = new TextEncoder().encode("exact private source");
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const sha256 = [...new Uint8Array(digest)]
			.map((value) => value.toString(16).padStart(2, "0"))
			.join("");
		const source = {
			versionId: "version-1",
			name: "source.mp4",
			mimeType: "video/mp4",
			bytes: bytes.buffer,
			byteSize: bytes.byteLength,
			sha256,
		};
		const file = await sourceFile({ source });
		expect(file.name).toBe("source.mp4");
		expect(file.type).toBe("video/mp4");
		expect(file.size).toBe(bytes.byteLength);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
		await expect(sourceFile({ source: { ...source, sha256: "a".repeat(64) } }))
			.rejects.toThrow("checksum changed before OpenCut import");
	});
});

describe("normalizedPreviewRange", () => {
	test("keeps one bounded compare request and rejects unknown modes or reversed ranges", () => {
    const input = { mode: "original" as const, mediaId: "kartel-repair-op-1", startSeconds: 2, endSeconds: 6 };
		expect(normalizedPreviewRange(input)).toEqual(input);
		expect(normalizedPreviewRange({ ...input, mode: "repaired" })?.mode).toBe("repaired");
		expect(normalizedPreviewRange({ ...input, mode: "stop" })?.mode).toBe("stop");
		expect(normalizedPreviewRange({ ...input, mode: "solo" })).toBeNull();
		expect(normalizedPreviewRange({ ...input, startSeconds: 6, endSeconds: 2 })).toBeNull();
		expect(normalizedPreviewRange({ ...input, mediaId: "" })).toBeNull();
	});

	test("builds a transient visual and audio mute patch without changing the source element", () => {
		const zero = mediaTimeFromSeconds({ seconds: 0 });
		const duration = mediaTimeFromSeconds({ seconds: 4 });
		const element = {
			id: "repair-element-1",
			name: "Repair",
			type: "video" as const,
			mediaId: "kartel-repair-op-1",
			hidden: false,
			params: { volume: -3, muted: false },
			duration,
			startTime: zero,
			trimStart: zero,
			trimEnd: zero,
		};
		const update = repairPreviewUpdate({
			tracks: [{
				id: "track-1",
				name: "Video",
				type: "video",
				hidden: false,
				muted: false,
				elements: [element],
			}],
			mediaId: element.mediaId,
			silenced: true,
		});
		expect(update).toEqual({
			trackId: "track-1",
			elementId: element.id,
			updates: { hidden: true, params: { volume: -3, muted: true } },
		});
		expect(element.hidden).toBe(false);
		expect(element.params.muted).toBe(false);
	});
});

describe("kartelMarkerBookmarks", () => {
	test("replaces only Kartel-owned bookmarks and keeps operator bookmarks", () => {
		const markers = normalizedMarkers({
			markers: [
				{ id: "issue-1", startSeconds: 2, endSeconds: 6, note: "Replace the voice-over", category: "dialogue" },
				{ id: "issue-2", startSeconds: 12, endSeconds: 12, note: "", category: "artifact" },
			],
		});
		expect(markers).toHaveLength(2);
		const operator = { time: mediaTimeFromSeconds({ seconds: 1 }), note: "my own note" };
		const stale = { time: mediaTimeFromSeconds({ seconds: 9 }), note: `${KARTEL_MARKER_PREFIX}old` };
		const bookmarks = kartelMarkerBookmarks({ markers: markers ?? [], existing: [operator, stale] });
		expect(bookmarks).toHaveLength(3);
		expect(bookmarks[0]).toEqual(operator);
		expect(bookmarks[1].note).toBe(`${KARTEL_MARKER_PREFIX}Replace the voice-over`);
		expect(bookmarks[1].duration).toEqual(mediaTimeFromSeconds({ seconds: 4 }));
		expect(bookmarks[2].note).toBe(`${KARTEL_MARKER_PREFIX}artifact`);
		expect(bookmarks[2].duration).toBeUndefined();
		expect(normalizedMarkers({ markers: [{ id: "x", startSeconds: 0, endSeconds: 1, note: "n", category: "colour" }] })).toBeNull();
		expect(normalizedMarkers({ markers: "nope" })).toBeNull();
	});
});

describe("normalizedBreakdown", () => {
	const candidate = {
		assetId: "asset-1",
		versionId: "version-1",
		name: "Dialogue",
		src: "https://studio.example/stems/dialogue.wav",
		mimeType: "audio/wav",
		byteSize: 1024,
		sha256: "a".repeat(64),
		durationSeconds: 12,
	};

	test("accepts ascending interior cuts, labelled shots, and audio-only stems", () => {
		const breakdown = normalizedBreakdown({
			sourceClipId: "clip-source",
			cuts: [3, 7.5],
			shots: [
				{ id: "shot-01", label: "Shot 1", startSeconds: 0, endSeconds: 3 },
				{ id: "shot-02", label: "Shot 2", startSeconds: 3, endSeconds: 7.5 },
				{ id: "shot-03", label: "Shot 3", startSeconds: 7.5, endSeconds: 12 },
			],
			stems: [{ role: "dialogue", label: "Dialogue", candidate }],
		});
		expect(breakdown?.cuts).toEqual([3, 7.5]);
		expect(breakdown?.shots.map((shot) => shot.label)).toEqual(["Shot 1", "Shot 2", "Shot 3"]);
		expect(breakdown?.stems[0]?.candidate.mimeType).toBe("audio/wav");
		expect(stemMediaId({ role: "dialogue", label: "Dialogue", candidate })).toBe("kartel-stem-dialogue-asset-1-version-1");
		expect(stemMediaId({ role: "dialogue", label: "Dialogue", candidate: { ...candidate, versionId: "version-2" } })).not.toBe(stemMediaId({ role: "dialogue", label: "Dialogue", candidate }));
	});

	test("rejects unordered cuts, non-audio stems, and duplicate stem roles", () => {
		const shots = [{ id: "shot-01", label: "Shot 1", startSeconds: 0, endSeconds: 5 }];
		expect(normalizedBreakdown({ cuts: [7, 3], shots, stems: [] })).toBeNull();
		expect(normalizedBreakdown({ cuts: [0], shots, stems: [] })).toBeNull();
		expect(normalizedBreakdown({ cuts: [], shots, stems: [{ role: "music", label: "Music", candidate: { ...candidate, mimeType: "video/mp4" } }] })).toBeNull();
		expect(normalizedBreakdown({ cuts: [], shots, stems: [
			{ role: "background", label: "Music & effects", candidate },
			{ role: "background", label: "Music & effects again", candidate },
		] })).toBeNull();
		expect(normalizedBreakdown({ cuts: [], shots, stems: [{ role: "music", label: "Music", candidate }] })).toBeNull();
		expect(normalizedBreakdown({ cuts: [], shots, stems: [{ role: "background", label: "Music & effects", candidate: { ...candidate, mimeType: "audio/mpeg" } }] })?.stems[0]?.candidate.mimeType).toBe("audio/mpeg");
		expect(normalizedBreakdown(null)).toBeNull();
	});
});

describe("normalizedRangeSelection", () => {
	test("selects by clip id or by a main-track start time, never by nothing", () => {
		expect(normalizedRangeSelection({ clipId: "clip-2" })).toEqual({ clipId: "clip-2", startSeconds: null, sourceSeconds: null });
		expect(normalizedRangeSelection({ startSeconds: 3.5 })).toEqual({ clipId: null, startSeconds: 3.5, sourceSeconds: null });
		expect(normalizedRangeSelection({ sourceSeconds: 8 })).toEqual({ clipId: null, startSeconds: null, sourceSeconds: 8 });
		expect(normalizedRangeSelection({ sourceSeconds: 8, startSeconds: 3 })).toBeNull();
		expect(normalizedRangeSelection({ sourceSeconds: -1 })).toBeNull();
		expect(normalizedRangeSelection({ startSeconds: -1 })).toBeNull();
		expect(normalizedRangeSelection({})).toBeNull();
	});
});

describe("breakdown source and timeline coordinates", () => {
	const seconds = (value: number) => mediaTimeFromSeconds({ seconds: value });
	const piece: VideoElement = {
		id: "piece-1", mediaId: "source-1", name: "Trimmed source", type: "video",
		startTime: seconds(20), duration: seconds(4), trimStart: seconds(6), trimEnd: seconds(10),
		params: { volume: 0, muted: false }, retime: { rate: 2 },
	};

	test("maps source cuts through a move, trim and speed change without splitting removed frames", () => {
		expect(breakdownSourceRange(piece)).toEqual({ startSeconds: 6, endSeconds: 14 });
    const track = { id: "main", name: "Main", type: "video" as const, muted: false, hidden: false, elements: [piece, { ...piece, id: "replacement", mediaId: "other" }] };
		expect(videoFinisherSourceLayout({ tracks: [track], sourceMediaId: "source-1" })).toEqual({ durationSeconds: 24, clips: [{ clipId: "piece-1", startSeconds: 20, endSeconds: 24, sourceStartSeconds: 6, sourceEndSeconds: 14 }] });
		expect(videoFinisherSourceLayout({ tracks: [track], sourceMediaId: null }).clips).toEqual([]);
		expect(breakdownCutTimelineSeconds({ element: piece, sourceSeconds: 10 })).toBe(22);
		expect(breakdownSourceAtTimeline({ element: piece, timelineSeconds: 22 })).toBe(10);
		for (const time of [19, 24, 30, Number.NaN]) expect(breakdownSourceAtTimeline({ element: piece, timelineSeconds: time })).toBeNull();
		for (const cut of [0, 6, 14, 20, Number.NaN]) expect(breakdownCutTimelineSeconds({ element: piece, sourceSeconds: cut })).toBeNull();
		const normal = { ...piece, startTime: seconds(0), trimStart: seconds(0), duration: seconds(15), retime: undefined };
		expect(breakdownCutTimelineSeconds({ element: normal, sourceSeconds: 10 })).toBe(10);
	});

	test("seats each audio layer at the matching timeline range and preserves its source offset and speed", () => {
		const geometry = breakdownStemGeometry({ piece, stemDurationSeconds: 30 });
		expect(mediaTimeToSeconds({ time: geometry.startTime })).toBe(20);
		expect(mediaTimeToSeconds({ time: geometry.duration })).toBe(4);
		expect(mediaTimeToSeconds({ time: geometry.trimStart })).toBe(6);
		expect(mediaTimeToSeconds({ time: geometry.trimEnd })).toBe(16);
		expect(geometry.retime).toEqual({ rate: 2 });
		expect(() => breakdownStemGeometry({ piece, stemDurationSeconds: 13.99 })).toThrow("does not cover");
		expect(() => breakdownStemGeometry({ piece, stemDurationSeconds: Number.NaN })).toThrow("does not cover");
	});
});
