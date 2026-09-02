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
	kartelMarkerBookmarks,
	normalizedMarkers,
	normalizedPreviewRange,
	normalizedRepairInsertion,
	repairMediaId,
	repairPreviewUpdate,
	sourceFile,
	videoFinisherExportFrameRate,
} from "../video-finisher-bridge";
import { mediaTimeFromSeconds } from "@/wasm";

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
			semanticRole: "replacement_voice",
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
		const input = { mode: "original", mediaId: "kartel-repair-op-1", startSeconds: 2, endSeconds: 6 };
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
