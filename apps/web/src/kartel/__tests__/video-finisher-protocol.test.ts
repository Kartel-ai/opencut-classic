import { describe, expect, test } from "bun:test";
import {
	buildVideoFinisherBridgeMessage,
	isKartelVideoFinisherRoute,
	VIDEO_FINISHER_BRIDGE,
	VIDEO_FINISHER_BRIDGE_VERSION,
} from "../video-finisher-protocol";

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
