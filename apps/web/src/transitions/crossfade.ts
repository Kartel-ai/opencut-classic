import type {
	ElementAnimations,
	ScalarAnimationChannel,
} from "@/animation/types";
import { isLeafChannelData } from "@/animation/channel-data";
import {
	isScalarChannel,
	normalizeScalarChannel,
} from "@/animation/interpolation";
import { resolveAnimationPathValueAtTime } from "@/animation/resolve";
import { mediaTime, TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type {
	ElementRef,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";

export type CrossfadeDirection = "in" | "out";

export const CROSSFADE_DURATION_LIMITS = {
	minSeconds: 0.1,
	maxSeconds: 3,
} as const;

const MIN_CROSSFADE_DURATION = mediaTime({
	ticks: Math.round(CROSSFADE_DURATION_LIMITS.minSeconds * TICKS_PER_SECOND),
});
const MAX_CROSSFADE_DURATION = mediaTime({
	ticks: Math.round(CROSSFADE_DURATION_LIMITS.maxSeconds * TICKS_PER_SECOND),
});

export type CrossfadeAnalysis =
	| { ok: false; reason: string }
	| {
			ok: true;
			outgoing: {
				trackId: string;
				track: VideoTrack;
				element: VideoElement;
			};
			incoming: {
				trackId: string;
				track: VideoTrack;
				element: VideoElement;
			};
	  };

export interface CrossfadePlan {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
	createdTrackId: string;
}

function getCrossfadeWindow({
	direction,
	duration,
	elementDuration,
}: {
	direction: CrossfadeDirection;
	duration: MediaTime;
	elementDuration: MediaTime;
}): { startTime: MediaTime; endTime: MediaTime } {
	return direction === "in"
		? { startTime: mediaTime({ ticks: 0 }), endTime: duration }
		: {
				startTime: mediaTime({ ticks: elementDuration - duration }),
				endTime: elementDuration,
			};
}

function hasAnimationConflict({
	element,
	path,
	direction,
	duration,
}: {
	element: VideoElement;
	path: "opacity" | "volume";
	direction: CrossfadeDirection;
	duration: MediaTime;
}): boolean {
	const channel = element.animations?.[path];
	if (!channel) return false;
	if (!isLeafChannelData(channel)) return true;
	if (channel.keys.length === 0) return false;
	if (!isScalarChannel(channel)) return true;

	const { startTime, endTime } = getCrossfadeWindow({
		direction,
		duration,
		elementDuration: element.duration,
	});
	if (
		channel.keys.some(
			(key) =>
				key.time < 0 ||
				key.time > element.duration ||
				(key.time >= startTime && key.time <= endTime),
		)
	) {
		return true;
	}

	return direction === "in"
		? channel.extrapolation?.before === "linear"
		: channel.extrapolation?.after === "linear";
}

export function analyzeCrossfadeSelection({
	tracks,
	selectedElements,
	duration,
	includeAudio,
}: {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
	duration: MediaTime;
	includeAudio: boolean;
}): CrossfadeAnalysis {
	if (selectedElements.length !== 2) {
		return { ok: false, reason: "Select exactly two adjacent video clips." };
	}

	const resolved: Array<{
		trackId: string;
		track: VideoTrack;
		element: VideoElement;
	}> = [];
	for (const ref of selectedElements) {
		const track =
			tracks.main.id === ref.trackId
				? tracks.main
				: tracks.overlay.find((candidate) => candidate.id === ref.trackId);
		const element = track?.elements.find(
			(candidate) => candidate.id === ref.elementId,
		);
		if (
			!track ||
			track.type !== "video" ||
			!element ||
			element.type !== "video"
		) {
			return {
				ok: false,
				reason: "Crossfade currently supports video clips only.",
			};
		}
		resolved.push({ trackId: track.id, track, element });
	}

	const ordered = resolved
		.map((item) => ({ ...item }))
		.sort((a, b) => a.element.startTime - b.element.startTime);
	const [outgoing, incoming] = ordered;
	const outgoingEnd = outgoing.element.startTime + outgoing.element.duration;

	if (outgoingEnd !== incoming.element.startTime) {
		return {
			ok: false,
			reason: "The selected clips must touch with no gap between them.",
		};
	}

	if (outgoing.trackId === incoming.trackId) {
		const orderedTrackElements = [...outgoing.track.elements].sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
		const outgoingIndex = orderedTrackElements.findIndex(
			(element) => element.id === outgoing.element.id,
		);
		const incomingIndex = orderedTrackElements.findIndex(
			(element) => element.id === incoming.element.id,
		);
		if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1) {
			return {
				ok: false,
				reason: "The selected clips must be consecutive on their track.",
			};
		}
	}

	if (duration < MIN_CROSSFADE_DURATION) {
		return {
			ok: false,
			reason: `Choose a crossfade of at least ${CROSSFADE_DURATION_LIMITS.minSeconds} seconds.`,
		};
	}

	if (duration > MAX_CROSSFADE_DURATION) {
		return {
			ok: false,
			reason: `Choose a crossfade no longer than ${CROSSFADE_DURATION_LIMITS.maxSeconds} seconds.`,
		};
	}

	if (
		duration > outgoing.element.duration ||
		duration > incoming.element.duration
	) {
		return {
			ok: false,
			reason: "The crossfade is longer than one of the selected clips.",
		};
	}

	const protectedPaths = includeAudio
		? (["opacity", "volume"] as const)
		: (["opacity"] as const);
	const transitionElements = [
		{ ...outgoing, direction: "out" as const },
		{ ...incoming, direction: "in" as const },
	];
	if (
		transitionElements.some(({ element, direction }) =>
			protectedPaths.some((path) =>
				hasAnimationConflict({ element, path, direction, duration }),
			),
		)
	) {
		return {
			ok: false,
			reason:
				"Remove opacity or volume keyframes inside the transition ranges before applying a crossfade.",
		};
	}

	return { ok: true, outgoing, incoming };
}

export function buildCrossfadePlan({
	tracks,
	selectedElements,
	duration,
	includeAudio,
	idFactory,
}: {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
	duration: MediaTime;
	includeAudio: boolean;
	idFactory: () => string;
}): CrossfadePlan {
	const analysis = analyzeCrossfadeSelection({
		tracks,
		selectedElements,
		duration,
		includeAudio,
	});
	if (!analysis.ok) {
		throw new Error(analysis.reason);
	}

	const { outgoing, incoming } = analysis;
	const createdTrackId = idFactory();
	const buildKeyframeIds = () => [idFactory(), idFactory()] as const;
	const buildAnimations = ({
		direction,
		element,
	}: {
		direction: CrossfadeDirection;
		element: VideoElement;
	}) =>
		buildCrossfadeAnimations({
			direction,
			duration,
			elementDuration: element.duration,
			baseOpacity:
				typeof element.params.opacity === "number" ? element.params.opacity : 1,
			baseVolume:
				includeAudio && typeof element.params.volume === "number"
					? element.params.volume
					: includeAudio
						? 0
						: undefined,
			existingAnimations: element.animations,
			keyframeIds: {
				opacity: buildKeyframeIds(),
				...(includeAudio ? { volume: buildKeyframeIds() } : {}),
			},
		});

	const nextOutgoing: VideoElement = {
		...outgoing.element,
		animations: buildAnimations({
			direction: "out",
			element: outgoing.element,
		}),
	};
	const overlapStartTime = mediaTime({
		ticks: outgoing.element.startTime + outgoing.element.duration - duration,
	});
	const nextIncoming: VideoElement = {
		...incoming.element,
		startTime: overlapStartTime,
		animations: buildAnimations({ direction: "in", element: incoming.element }),
	};
	const incomingOriginalEnd = mediaTime({
		ticks: incoming.element.startTime + incoming.element.duration,
	});
	const shiftFollowingElement = <
		TElement extends VideoTrack["elements"][number],
	>(
		element: TElement,
	): TElement =>
		element.startTime >= incomingOriginalEnd
			? ({
					...element,
					startTime: mediaTime({ ticks: element.startTime - duration }),
				} as TElement)
			: element;

	let nextTracks = tracks;
	if (outgoing.trackId === incoming.trackId) {
		const nextSourceTrack: VideoTrack = {
			...incoming.track,
			elements: incoming.track.elements.flatMap((element) => {
				if (element.id === incoming.element.id) return [];
				if (element.id === outgoing.element.id) return [nextOutgoing];
				return [shiftFollowingElement(element)];
			}),
		};
		nextTracks = replaceVideoTrack({
			tracks: nextTracks,
			track: nextSourceTrack,
		});
	} else {
		const nextOutgoingTrack: VideoTrack = {
			...outgoing.track,
			elements: outgoing.track.elements.map((element) =>
				element.id === outgoing.element.id ? nextOutgoing : element,
			),
		};
		const nextIncomingTrack: VideoTrack = {
			...incoming.track,
			elements: incoming.track.elements.flatMap((element) =>
				element.id === incoming.element.id
					? []
					: [shiftFollowingElement(element)],
			),
		};
		nextTracks = replaceVideoTrack({
			tracks: nextTracks,
			track: nextOutgoingTrack,
		});
		nextTracks = replaceVideoTrack({
			tracks: nextTracks,
			track: nextIncomingTrack,
		});
	}
	const crossfadeTrack: VideoTrack = {
		...buildEmptyTrack({ id: createdTrackId, type: "video" }),
		name: "Crossfade overlay",
		elements: [nextIncoming],
	};

	const selectedOverlayIndices = [outgoing.trackId, incoming.trackId].flatMap(
		(trackId) => {
			const index = tracks.overlay.findIndex((track) => track.id === trackId);
			return index >= 0 ? [index] : [];
		},
	);
	const crossfadeTrackIndex =
		selectedOverlayIndices.length > 0
			? Math.min(...selectedOverlayIndices)
			: nextTracks.overlay.length;
	const nextOverlay = [...nextTracks.overlay];
	nextOverlay.splice(crossfadeTrackIndex, 0, crossfadeTrack);
	nextTracks = { ...nextTracks, overlay: nextOverlay };

	return {
		tracks: nextTracks,
		selectedElements: [
			{ trackId: outgoing.trackId, elementId: outgoing.element.id },
			{ trackId: createdTrackId, elementId: incoming.element.id },
		],
		createdTrackId,
	};
}

function replaceVideoTrack({
	tracks,
	track,
}: {
	tracks: SceneTracks;
	track: VideoTrack;
}): SceneTracks {
	if (tracks.main.id === track.id) {
		return { ...tracks, main: track };
	}

	return {
		...tracks,
		overlay: tracks.overlay.map((candidate) =>
			candidate.id === track.id ? track : candidate,
		),
	};
}

function buildLinearChannel({
	startTime,
	endTime,
	startValue,
	endValue,
	keyframeIds,
	existingChannel,
	endSegmentToNext = "linear",
}: {
	startTime: MediaTime;
	endTime: MediaTime;
	startValue: number;
	endValue: number;
	keyframeIds: readonly [string, string];
	existingChannel?: ScalarAnimationChannel;
	endSegmentToNext?: "linear" | "step";
}): ScalarAnimationChannel {
	const existingKeys = existingChannel?.keys ?? [];
	if (
		existingKeys.some((key) => key.time >= startTime && key.time <= endTime)
	) {
		throw new Error("Crossfade would overwrite existing animation keyframes");
	}

	const preservedKeys = existingKeys.map((key, index) => {
		const isLastKeyBeforeWindow =
			key.time < startTime &&
			existingKeys
				.slice(index + 1)
				.every((candidate) => candidate.time >= startTime);
		return isLastKeyBeforeWindow
			? { ...key, segmentToNext: "step" as const, rightHandle: undefined }
			: key;
	});

	return normalizeScalarChannel({
		channel: {
			...existingChannel,
			keys: [
				...preservedKeys,
				{
					id: keyframeIds[0],
					time: startTime,
					value: startValue,
					segmentToNext: "linear",
					tangentMode: "auto",
				},
				{
					id: keyframeIds[1],
					time: endTime,
					value: endValue,
					segmentToNext: endSegmentToNext,
					tangentMode: "auto",
				},
			],
		},
	});
}

function getExistingScalarChannel({
	animations,
	path,
}: {
	animations: ElementAnimations | undefined;
	path: "opacity" | "volume";
}): ScalarAnimationChannel | undefined {
	const channel = animations?.[path];
	if (!channel) return undefined;
	if (!isLeafChannelData(channel)) {
		throw new Error(`Crossfade cannot merge composite ${path} animation data`);
	}
	if (channel.keys.length === 0) {
		return {
			keys: [],
			...("extrapolation" in channel && channel.extrapolation
				? { extrapolation: channel.extrapolation }
				: {}),
		};
	}
	if (!isScalarChannel(channel)) {
		throw new Error(`Crossfade cannot merge non-scalar ${path} animation data`);
	}
	return channel;
}

export function buildCrossfadeAnimations({
	direction,
	duration,
	elementDuration,
	baseOpacity,
	baseVolume,
	existingAnimations,
	keyframeIds,
}: {
	direction: CrossfadeDirection;
	duration: MediaTime;
	elementDuration: MediaTime;
	baseOpacity: number;
	baseVolume?: number;
	existingAnimations?: ElementAnimations;
	keyframeIds: {
		opacity: readonly [string, string];
		volume?: readonly [string, string];
	};
}): ElementAnimations {
	if (duration <= 0 || duration > elementDuration) {
		throw new Error("Crossfade duration must fit within the clip duration");
	}

	const { startTime, endTime } = getCrossfadeWindow({
		direction,
		duration,
		elementDuration,
	});
	const opacityAtBoundary = resolveAnimationPathValueAtTime({
		animations: existingAnimations,
		propertyPath: "opacity",
		localTime: direction === "in" ? endTime : startTime,
		fallbackValue: baseOpacity,
	});
	const startOpacity = direction === "in" ? 0 : opacityAtBoundary;
	const endOpacity = direction === "in" ? opacityAtBoundary : 0;
	const animations: ElementAnimations = {
		...existingAnimations,
		opacity: buildLinearChannel({
			startTime,
			endTime,
			startValue: startOpacity,
			endValue: endOpacity,
			keyframeIds: keyframeIds.opacity,
			existingChannel: getExistingScalarChannel({
				animations: existingAnimations,
				path: "opacity",
			}),
			endSegmentToNext: direction === "in" ? "step" : "linear",
		}),
	};

	if (baseVolume !== undefined && keyframeIds.volume) {
		const volumeAtBoundary = resolveAnimationPathValueAtTime({
			animations: existingAnimations,
			propertyPath: "volume",
			localTime: direction === "in" ? endTime : startTime,
			fallbackValue: baseVolume,
		});
		animations.volume = buildLinearChannel({
			startTime,
			endTime,
			startValue: direction === "in" ? VOLUME_DB_MIN : volumeAtBoundary,
			endValue: direction === "in" ? volumeAtBoundary : VOLUME_DB_MIN,
			keyframeIds: keyframeIds.volume,
			existingChannel: getExistingScalarChannel({
				animations: existingAnimations,
				path: "volume",
			}),
			endSegmentToNext: direction === "in" ? "step" : "linear",
		});
	}

	return animations;
}
