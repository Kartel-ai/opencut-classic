import type { AudioElement, SceneTracks } from "@/timeline/types";

// One browser-editor snapshot changes the audible mix without changing picture
// elements, source media, track contents or their saved pre-Keep mute state.
export function soundtrackTracks({ tracks, element, trackId }: { tracks: SceneTracks; element: AudioElement; trackId: string }): SceneTracks {
	if ([tracks.main, ...tracks.overlay, ...tracks.audio].some(track => track.kartelSolo)) {
		throw new Error("Turn Solo off before keeping a new soundtrack.");
	}
	if (!("mediaId" in element)) throw new Error("The soundtrack needs exact uploaded media.");
	const mediaId = element.mediaId;
	if (tracks.audio.some(track => track.elements.some(item => "mediaId" in item && item.mediaId === mediaId))) return tracks;
	return {
		main: { ...tracks.main, muted: true },
		overlay: tracks.overlay.map(track => track.type === "video" ? { ...track, muted: true } : track),
		audio: [...tracks.audio.map(track => ({ ...track, muted: true })), { id: trackId, type: "audio", name: "Improved sound", muted: false, elements: [element] }],
	};
}
