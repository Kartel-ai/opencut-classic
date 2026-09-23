import type { SceneTracks, TimelineTrack } from "@/timeline/types";

export function kartelSoloTrackId(tracks: TimelineTrack[]): string | null {
	return tracks.find((track) => track.kartelSolo?.selected)?.id ?? null;
}

export function kartelSoloTracks({ tracks, trackId }: { tracks: SceneTracks; trackId: string }): SceneTracks {
	const all = [...tracks.overlay, tracks.main, ...tracks.audio];
	if (!all.some((track) => track.id === trackId && "muted" in track)) return tracks;
	const nextId = kartelSoloTrackId(all) === trackId ? null : trackId;
	const update = <T extends TimelineTrack>(track: T): T => {
		if (!("muted" in track)) return track;
		const originalMuted = track.kartelSolo?.originalMuted ?? track.muted;
		if (nextId === null) {
			const next = { ...track, muted: originalMuted };
			delete next.kartelSolo;
			return next;
		}
		return { ...track, muted: track.id !== nextId, kartelSolo: { originalMuted, selected: track.id === nextId } };
	};
	return { ...tracks, overlay: tracks.overlay.map(update), main: update(tracks.main), audio: tracks.audio.map(update) };
}
