import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { isLeafChannelData } from "@/animation/channel-data";
import { isScalarChannel } from "@/animation/interpolation";
import {
	analyzeCrossfadeSelection,
	buildCrossfadeAnimations,
	buildCrossfadePlan,
} from "@/transitions/crossfade";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildVideoElement({
	id,
	startTime,
	duration = 120_000,
}: {
	id: string;
	startTime: number;
	duration?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: `media-${id}`,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			volume: 0,
		},
	};
}

function buildTracks(elements: VideoTrack["elements"]): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			type: "video",
			name: "Main",
			elements,
			muted: false,
			hidden: false,
		},
		audio: [],
	};
}

function getScalarKeyValues({
	element,
	path,
}: {
	element: VideoElement;
	path: "opacity" | "volume";
}): number[] {
	const channel = element.animations?.[path];
	if (!isLeafChannelData(channel) || !isScalarChannel(channel)) {
		throw new Error(`Expected scalar ${path} channel`);
	}
	return channel.keys.map((key) => key.value);
}

describe("buildCrossfadeAnimations", () => {
	test("builds persisted preview and export channels for overlapping clips", () => {
		const duration = mediaTime({ ticks: 24_000 });
		const elementDuration = mediaTime({ ticks: 120_000 });
		const outgoing = buildCrossfadeAnimations({
			direction: "out",
			duration,
			elementDuration,
			baseOpacity: 1,
			baseVolume: 0,
			existingAnimations: {
				"transform.positionX": {
					keys: [],
				},
			},
			keyframeIds: {
				opacity: ["out-opacity-start", "out-opacity-end"],
				volume: ["out-volume-start", "out-volume-end"],
			},
		});
		const incoming = buildCrossfadeAnimations({
			direction: "in",
			duration,
			elementDuration,
			baseOpacity: 1,
			baseVolume: 0,
			keyframeIds: {
				opacity: ["in-opacity-start", "in-opacity-end"],
				volume: ["in-volume-start", "in-volume-end"],
			},
		});

		expect(outgoing["transform.positionX"]).toBeDefined();
		expect(
			resolveAnimationPathValueAtTime({
				animations: outgoing,
				propertyPath: "opacity",
				localTime: 108_000,
				fallbackValue: 1,
			}),
		).toBeCloseTo(0.5);
		expect(
			resolveAnimationPathValueAtTime({
				animations: incoming,
				propertyPath: "opacity",
				localTime: 12_000,
				fallbackValue: 1,
			}),
		).toBeCloseTo(0.5);
		expect(
			resolveAnimationPathValueAtTime({
				animations: incoming,
				propertyPath: "volume",
				localTime: 12_000,
				fallbackValue: 0,
			}),
		).toBeCloseTo(-30);
	});

	test("rejects a crossfade longer than its clip", () => {
		expect(() =>
			buildCrossfadeAnimations({
				direction: "in",
				duration: mediaTime({ ticks: 120_001 }),
				elementDuration: mediaTime({ ticks: 120_000 }),
				baseOpacity: 1,
				keyframeIds: { opacity: ["start", "end"] },
			}),
		).toThrow(/fit within/);
	});

	test("plans a real overlap on a dedicated video track", () => {
		const tracks = buildTracks([
			buildVideoElement({ id: "outgoing", startTime: 0 }),
			buildVideoElement({ id: "incoming", startTime: 120_000 }),
		]);
		let nextId = 0;
		const plan = buildCrossfadePlan({
			tracks,
			selectedElements: [
				{ trackId: "main", elementId: "outgoing" },
				{ trackId: "main", elementId: "incoming" },
			],
			duration: mediaTime({ ticks: 24_000 }),
			includeAudio: true,
			idFactory: () => `generated-${nextId++}`,
		});

		expect(tracks.main.elements).toHaveLength(2);
		expect(plan.tracks.main.elements.map((element) => element.id)).toEqual([
			"outgoing",
		]);
		expect(plan.tracks.overlay).toHaveLength(1);
		expect(plan.tracks.overlay[0].name).toBe("Crossfade overlay");
		const incoming = plan.tracks.overlay[0].elements[0];
		if (incoming.type !== "video") {
			throw new Error("Expected incoming video element");
		}
		expect(incoming.id).toBe("incoming");
		expect(incoming.startTime).toBe(mediaTime({ ticks: 96_000 }));
		expect(getScalarKeyValues({ element: incoming, path: "opacity" })).toEqual([
			0, 1,
		]);
		expect(getScalarKeyValues({ element: incoming, path: "volume" })).toEqual([
			-60, 0,
		]);
		expect(plan.selectedElements).toEqual([
			{ trackId: "main", elementId: "outgoing" },
			{ trackId: "generated-0", elementId: "incoming" },
		]);
	});

	test("requires clips that touch on the same track", () => {
		const tracks = buildTracks([
			buildVideoElement({ id: "outgoing", startTime: 0 }),
			buildVideoElement({ id: "incoming", startTime: 121_000 }),
		]);
		const analysis = analyzeCrossfadeSelection({
			tracks,
			selectedElements: [
				{ trackId: "main", elementId: "outgoing" },
				{ trackId: "main", elementId: "incoming" },
			],
			duration: mediaTime({ ticks: 24_000 }),
			includeAudio: true,
		});

		expect(analysis).toEqual({
			ok: false,
			reason: "The selected clips must touch with no clip or gap between them.",
		});
	});
});
