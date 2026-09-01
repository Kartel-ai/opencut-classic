import { describe, expect, test } from "bun:test";
import {
	buildVideoFinisherBridgeMessage,
	isKartelVideoFinisherRoute,
	VIDEO_FINISHER_BRIDGE,
	VIDEO_FINISHER_BRIDGE_VERSION,
} from "../video-finisher-protocol";
import { normalizedRepairInsertion, repairMediaId } from "../video-finisher-bridge";

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
