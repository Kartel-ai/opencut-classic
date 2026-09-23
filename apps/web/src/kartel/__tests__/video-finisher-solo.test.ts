import { expect, test } from "bun:test";
import { kartelSoloTrackId, kartelSoloTracks } from "../video-finisher-solo";
import type { SceneTracks } from "@/timeline/types";

test("Solo preserves the original mix through switching, serialization and clearing", () => {
	const tracks: SceneTracks = {
		main: { id: "video", name: "Video", type: "video", elements: [], muted: true, hidden: false },
		overlay: [],
		audio: [
			{ id: "voice", name: "Voice", type: "audio", elements: [], muted: false },
			{ id: "music", name: "Music", type: "audio", elements: [], muted: true },
		],
	};
	const voice = kartelSoloTracks({ tracks, trackId: "voice" });
	expect(kartelSoloTrackId([voice.main, ...voice.audio])).toBe("voice");
	const music = kartelSoloTracks({ tracks: JSON.parse(JSON.stringify(voice)), trackId: "music" });
	expect(music.audio.map((track) => track.muted)).toEqual([true, false]);
	expect(kartelSoloTracks({ tracks: music, trackId: "music" })).toEqual(tracks);
	expect(tracks.audio[0].muted).toBe(false);
	expect(kartelSoloTracks({ tracks, trackId: "missing" })).toBe(tracks);
});
