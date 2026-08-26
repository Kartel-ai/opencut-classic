import type {
	ElementAnimations,
	ScalarAnimationChannel,
} from "@/animation/types";
import { isLeafChannelData } from "@/animation/channel-data";
import { mediaTime, type MediaTime } from "@/wasm";
import { VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type {
	ElementRef,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";

export type CrossfadeDirection = "in" | "out";

export type CrossfadeAnalysis =
	| { ok: false; reason: string }
	| {
			ok: true;
			outgoing: { trackId: string; element: VideoElement };
			incoming: { trackId: string; element: VideoElement };
			sourceTrack: VideoTrack;
	  };

export interface CrossfadePlan {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
	createdTrackId: string;
}

function hasAnimationKeys({
	element,
	path,
}: {
	element: VideoElement;
	path: "opacity" | "volume";
}): boolean {
	const channel = element.animations?.[path];
	return isLeafChannelData(channel) && channel.keys.length > 0;
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

	if (resolved[0].track.id !== resolved[1].track.id) {
		return {
			ok: false,
			reason: "Select two adjacent clips on the same video track.",
		};
	}

	const ordered = resolved
		.map((item) => ({
			trackId: item.trackId,
			element: item.element,
		}))
		.sort((a, b) => a.element.startTime - b.element.startTime);
	const [outgoing, incoming] = ordered;
	const sourceTrack = resolved[0].track;
	const orderedTrackElements = [...sourceTrack.elements].sort((a, b) => {
		if (a.startTime !== b.startTime) return a.startTime - b.startTime;
		return a.id.localeCompare(b.id);
	});
	const outgoingIndex = orderedTrackElements.findIndex(
		(element) => element.id === outgoing.element.id,
	);
	const incomingIndex = orderedTrackElements.findIndex(
		(element) => element.id === incoming.element.id,
	);
	const outgoingEnd = outgoing.element.startTime + outgoing.element.duration;

	if (
		outgoingIndex < 0 ||
		incomingIndex !== outgoingIndex + 1 ||
		outgoingEnd !== incoming.element.startTime
	) {
		return {
			ok: false,
			reason: "The selected clips must touch with no clip or gap between them.",
		};
	}

	if (duration <= 0) {
		return { ok: false, reason: "Choose a crossfade duration above zero." };
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
	if (
		ordered.some(({ element }) =>
			protectedPaths.some((path) => hasAnimationKeys({ element, path })),
		)
	) {
		return {
			ok: false,
			reason:
				"Remove existing opacity or volume keyframes from these clips before applying a crossfade.",
		};
	}

	return { ok: true, outgoing, incoming, sourceTrack };
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

	const { outgoing, incoming, sourceTrack } = analysis;
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
	const nextSourceTrack: VideoTrack = {
		...sourceTrack,
		elements: sourceTrack.elements
			.filter((element) => element.id !== incoming.element.id)
			.map((element) =>
				element.id === outgoing.element.id ? nextOutgoing : element,
			),
	};
	const crossfadeTrack: VideoTrack = {
		...buildEmptyTrack({ id: createdTrackId, type: "video" }),
		name: "Crossfade overlay",
		elements: [nextIncoming],
	};

	let nextTracks: SceneTracks;
	if (tracks.main.id === sourceTrack.id) {
		nextTracks = {
			...tracks,
			overlay: [...tracks.overlay, crossfadeTrack],
			main: nextSourceTrack,
		};
	} else {
		const sourceIndex = tracks.overlay.findIndex(
			(track) => track.id === sourceTrack.id,
		);
		const updatedOverlay = tracks.overlay.map((track) =>
			track.id === sourceTrack.id ? nextSourceTrack : track,
		);
		updatedOverlay.splice(sourceIndex, 0, crossfadeTrack);
		nextTracks = { ...tracks, overlay: updatedOverlay };
	}

	return {
		tracks: nextTracks,
		selectedElements: [
			{ trackId: outgoing.trackId, elementId: outgoing.element.id },
			{ trackId: createdTrackId, elementId: incoming.element.id },
		],
		createdTrackId,
	};
}

function buildLinearChannel({
	startTime,
	endTime,
	startValue,
	endValue,
	keyframeIds,
}: {
	startTime: MediaTime;
	endTime: MediaTime;
	startValue: number;
	endValue: number;
	keyframeIds: readonly [string, string];
}): ScalarAnimationChannel {
	return {
		keys: [
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
				segmentToNext: "linear",
				tangentMode: "auto",
			},
		],
	};
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

	const startTime = direction === "in" ? 0 : elementDuration - duration;
	const endTime = direction === "in" ? duration : elementDuration;
	const startOpacity = direction === "in" ? 0 : baseOpacity;
	const endOpacity = direction === "in" ? baseOpacity : 0;
	const animations: ElementAnimations = {
		...existingAnimations,
		opacity: buildLinearChannel({
			startTime: mediaTime({ ticks: startTime }),
			endTime: mediaTime({ ticks: endTime }),
			startValue: startOpacity,
			endValue: endOpacity,
			keyframeIds: keyframeIds.opacity,
		}),
	};

	if (baseVolume !== undefined && keyframeIds.volume) {
		animations.volume = buildLinearChannel({
			startTime: mediaTime({ ticks: startTime }),
			endTime: mediaTime({ ticks: endTime }),
			startValue: direction === "in" ? VOLUME_DB_MIN : baseVolume,
			endValue: direction === "in" ? baseVolume : VOLUME_DB_MIN,
			keyframeIds: keyframeIds.volume,
		});
	}

	return animations;
}
