import type { AudioElement, SceneTracks } from "@/timeline/types";

// One browser-editor snapshot changes the audible mix without changing picture
// elements, source media, track contents or their saved pre-Keep mute state.
// RS-324: an effects-only take ("effects") joins the separated layers instead of replacing them:
// the picture's own audio and every other track fall silent, while the dialogue and music layers
// (Studio's `kartel-stem-*` media) keep their state, and the take lands on an Effects track.
export function soundtrackTracks({ tracks, element, trackId, mix }: { tracks: SceneTracks; element: AudioElement; trackId: string; mix?: "effects" }): SceneTracks {
	if ([tracks.main, ...tracks.overlay, ...tracks.audio].some(track => track.kartelSolo)) {
		throw new Error("Turn Solo off before keeping a new soundtrack.");
	}
	if (!("mediaId" in element)) throw new Error("The soundtrack needs exact uploaded media.");
	const mediaId = element.mediaId;
	if (tracks.audio.some(track => track.elements.some(item => "mediaId" in item && item.mediaId === mediaId))) return tracks;
	const layer = (track: SceneTracks["audio"][number]) => mix === "effects" && track.elements.some(item => "mediaId" in item && String(item.mediaId).startsWith("kartel-stem-"));
	return {
		main: { ...tracks.main, muted: true },
		overlay: tracks.overlay.map(track => track.type === "video" ? { ...track, muted: true } : track),
		audio: [...tracks.audio.map(track => (layer(track) ? track : { ...track, muted: true })), { id: trackId, type: "audio", name: mix === "effects" ? "Effects" : "Improved sound", muted: false, elements: [element] }],
	};
}

// RS-324: an Effects track is the one an effects-only Keep added (its id is `sound-<operation>`).
export function isKartelEffectsTrack(track: { id: string; name?: string }): boolean {
	return track.id.startsWith("sound-") && track.name === "Effects";
}
