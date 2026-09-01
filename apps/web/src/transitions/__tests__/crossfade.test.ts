import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { isLeafChannelData } from "@/animation/channel-data";
import { isScalarChannel } from "@/animation/interpolation";
import { ApplyCrossfadeCommand } from "@/commands/timeline";
import { EditorCore } from "@/core";
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

	test("keeps following clips continuous after shortening the edit", () => {
		const tracks = buildTracks([
			buildVideoElement({ id: "outgoing", startTime: 0 }),
			buildVideoElement({ id: "incoming", startTime: 120_000 }),
			buildVideoElement({ id: "following", startTime: 240_000 }),
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

		const incoming = plan.tracks.overlay[0].elements[0];
		const following = plan.tracks.main.elements.find(
			(element) => element.id === "following",
		);
		expect(incoming.startTime + incoming.duration).toBe(
			mediaTime({ ticks: 216_000 }),
		);
		expect(following?.startTime).toBe(mediaTime({ ticks: 216_000 }));
		expect(tracks.main.elements[2].startTime).toBe(
			mediaTime({ ticks: 240_000 }),
		);
	});

	test("chains crossfades across three clips without overwriting the first fade", () => {
		const tracks = buildTracks([
			buildVideoElement({ id: "a", startTime: 0 }),
			buildVideoElement({ id: "b", startTime: 120_000 }),
			buildVideoElement({ id: "c", startTime: 240_000 }),
		]);
		let nextId = 0;
		const firstPlan = buildCrossfadePlan({
			tracks,
			selectedElements: [
				{ trackId: "main", elementId: "a" },
				{ trackId: "main", elementId: "b" },
			],
			duration: mediaTime({ ticks: 24_000 }),
			includeAudio: true,
			idFactory: () => `generated-${nextId++}`,
		});
		const bRef = firstPlan.selectedElements.find(
			(ref) => ref.elementId === "b",
		);
		if (!bRef) throw new Error("Expected selected middle clip");

		const secondPlan = buildCrossfadePlan({
			tracks: firstPlan.tracks,
			selectedElements: [bRef, { trackId: "main", elementId: "c" }],
			duration: mediaTime({ ticks: 24_000 }),
			includeAudio: true,
			idFactory: () => `generated-${nextId++}`,
		});

		const videoElements = secondPlan.tracks.overlay.flatMap((track) =>
			track.type === "video" ? track.elements : [],
		);
		const middle = videoElements.find((element) => element.id === "b");
		const incoming = videoElements.find((element) => element.id === "c");
		if (middle?.type !== "video" || incoming?.type !== "video") {
			throw new Error("Expected chained video clips");
		}
		expect(getScalarKeyValues({ element: middle, path: "opacity" })).toEqual([
			0, 1, 1, 0,
		]);
		expect(getScalarKeyValues({ element: middle, path: "volume" })).toEqual([
			-60, 0, 0, -60,
		]);
		expect(middle.startTime + middle.duration - incoming.startTime).toBe(
			mediaTime({ ticks: 24_000 }),
		);
		expect(
			secondPlan.tracks.main.elements.map((element) => element.id),
		).toEqual(["a"]);
	});

	test("refuses keyframes inside a transition range but preserves distant keys", () => {
		const outgoing = buildVideoElement({ id: "outgoing", startTime: 0 });
		outgoing.animations = buildCrossfadeAnimations({
			direction: "in",
			duration: mediaTime({ ticks: 24_000 }),
			elementDuration: outgoing.duration,
			baseOpacity: 1,
			keyframeIds: { opacity: ["existing-start", "existing-end"] },
		});
		const incoming = buildVideoElement({ id: "incoming", startTime: 120_000 });
		const tracks = buildTracks([outgoing, incoming]);
		const analysis = analyzeCrossfadeSelection({
			tracks,
			selectedElements: [
				{ trackId: "main", elementId: "outgoing" },
				{ trackId: "main", elementId: "incoming" },
			],
			duration: mediaTime({ ticks: 24_000 }),
			includeAudio: false,
		});
		expect(analysis.ok).toBe(true);

		incoming.animations = buildCrossfadeAnimations({
			direction: "in",
			duration: mediaTime({ ticks: 24_000 }),
			elementDuration: incoming.duration,
			baseOpacity: 1,
			keyframeIds: { opacity: ["conflict-start", "conflict-end"] },
		});
		const conflictingAnalysis = analyzeCrossfadeSelection({
			tracks,
			selectedElements: [
				{ trackId: "main", elementId: "outgoing" },
				{ trackId: "main", elementId: "incoming" },
			],
			duration: mediaTime({ ticks: 24_000 }),
			includeAudio: false,
		});
		expect(conflictingAnalysis).toEqual({
			ok: false,
			reason:
				"Remove opacity or volume keyframes inside the transition ranges before applying a crossfade.",
		});
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
			reason: "The selected clips must touch with no gap between them.",
		});
	});

	test("enforces the duration range advertised by the editor", () => {
		const tracks = buildTracks([
			buildVideoElement({ id: "outgoing", startTime: 0, duration: 480_000 }),
			buildVideoElement({
				id: "incoming",
				startTime: 480_000,
				duration: 480_000,
			}),
		]);
		const selectedElements = [
			{ trackId: "main", elementId: "outgoing" },
			{ trackId: "main", elementId: "incoming" },
		];

		expect(
			analyzeCrossfadeSelection({
				tracks,
				selectedElements,
				duration: mediaTime({ ticks: 11_999 }),
				includeAudio: false,
			}),
		).toEqual({
			ok: false,
			reason: "Choose a crossfade of at least 0.1 seconds.",
		});
		expect(
			analyzeCrossfadeSelection({
				tracks,
				selectedElements,
				duration: mediaTime({ ticks: 360_001 }),
				includeAudio: false,
			}),
		).toEqual({
			ok: false,
			reason: "Choose a crossfade no longer than 3 seconds.",
		});
	});
});

describe("ApplyCrossfadeCommand", () => {
	test("applies, undoes, and redoes one atomic track snapshot", () => {
		const before = buildTracks([
			buildVideoElement({ id: "before", startTime: 0 }),
		]);
		const after = buildTracks([
			buildVideoElement({ id: "after", startTime: 0 }),
		]);
		const selectedElements = [{ trackId: "main", elementId: "after" }];
		const updates: SceneTracks[] = [];
		const originalGetInstance = Object.getOwnPropertyDescriptor(
			EditorCore,
			"getInstance",
		);
		Object.defineProperty(EditorCore, "getInstance", {
			configurable: true,
			value: () => ({
				timeline: {
					updateTracks: (tracks: SceneTracks) => updates.push(tracks),
				},
			}),
		});

		try {
			const command = new ApplyCrossfadeCommand({
				before,
				after,
				selectedElements,
			});
			expect(command.execute()).toEqual({
				selection: {
					selectedElements,
					selectedKeyframes: [],
					keyframeSelectionAnchor: null,
					selectedMaskPoints: null,
				},
			});
			command.undo();
			command.redo();
			expect(updates).toEqual([after, before, after]);
		} finally {
			if (originalGetInstance) {
				Object.defineProperty(EditorCore, "getInstance", originalGetInstance);
			}
		}
	});
});
