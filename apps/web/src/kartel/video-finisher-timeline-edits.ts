import type { Command } from "@/commands/base-command";
import {
	DeleteElementsCommand,
	SplitElementsCommand,
	TracksSnapshotCommand,
	UpdateElementsCommand,
	UpsertKeyframeCommand,
} from "@/commands/timeline";
import type { EditorCore } from "@/core";
import type { ScalarChannel } from "@/animation/types";
import { isScalarChannel } from "@/animation/interpolation";
import { isLeafChannelData } from "@/animation/channel-data";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";

// RS-067 (Elliot, 2026-09-22): the free, reversible edits Studio's seat applies at once. Studio
// plans them from the operator's sentence (`videoFinisherTimelineEdits.js`); the editor
// re-validates the list, runs it on the current tracks, and records the whole change as one
// OpenCut snapshot command, so the reply's Undo and OpenCut's own undo reverse the same step.

export type KartelLaneRole = "dialogue" | "background";
export type KartelTimelineEdit =
	| { kind: "ripple_delete"; startSeconds: number; endSeconds: number }
	| {
			kind: "duck";
			role: "background";
			db: number;
			rampSeconds: number;
			regions: { startSeconds: number; endSeconds: number }[];
	  }
	| { kind: "level"; role: KartelLaneRole; deltaDb: number }
	| { kind: "mute"; role: KartelLaneRole; muted: boolean }
	| { kind: "remove_take"; mediaIdPrefix: string };

const MAX_EDITS = 12;
const MAX_REGIONS = 60;
const DB_LIMIT = 24;
const isRole = (value: unknown): value is KartelLaneRole => value === "dialogue" || value === "background";
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

export function normalizedTimelineEdits(value: unknown): KartelTimelineEdit[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EDITS) return null;
	const edits: KartelTimelineEdit[] = [];
	for (const raw of value) {
		if (!isRecord(raw)) return null;
		const edit = raw;
		if (edit.kind === "ripple_delete") {
			if (!finite(edit.startSeconds) || !finite(edit.endSeconds) || edit.startSeconds < 0 || edit.endSeconds - edit.startSeconds < 0.04) return null;
			edits.push({ kind: "ripple_delete", startSeconds: edit.startSeconds, endSeconds: edit.endSeconds });
		} else if (edit.kind === "duck") {
			const regions = Array.isArray(edit.regions) ? edit.regions : null;
			if (edit.role !== "background" || !finite(edit.db) || edit.db > 0 || edit.db < -40 || !regions || regions.length < 1 || regions.length > MAX_REGIONS) return null;
			const normalized = regions.map((region) => {
				if (!isRecord(region)) return null;
				const item = region;
				return finite(item.startSeconds) && finite(item.endSeconds) && item.endSeconds > item.startSeconds && item.startSeconds >= 0
					? { startSeconds: item.startSeconds, endSeconds: item.endSeconds }
					: null;
			});
			if (normalized.some((region) => region === null)) return null;
			const ramp = finite(edit.rampSeconds) ? Math.min(1, Math.max(0.05, edit.rampSeconds)) : 0.2;
			edits.push({ kind: "duck", role: "background", db: edit.db, rampSeconds: ramp, regions: normalized.filter((region) => region !== null) });
		} else if (edit.kind === "level") {
			if (!isRole(edit.role) || !finite(edit.deltaDb) || edit.deltaDb === 0 || Math.abs(edit.deltaDb) > DB_LIMIT) return null;
			edits.push({ kind: "level", role: edit.role, deltaDb: edit.deltaDb });
		} else if (edit.kind === "mute") {
			if (!isRole(edit.role) || typeof edit.muted !== "boolean") return null;
			edits.push({ kind: "mute", role: edit.role, muted: edit.muted });
		} else if (edit.kind === "remove_take") {
			if (typeof edit.mediaIdPrefix !== "string" || !edit.mediaIdPrefix.startsWith("kartel-repair-") || edit.mediaIdPrefix.length > 240) return null;
			edits.push({ kind: "remove_take", mediaIdPrefix: edit.mediaIdPrefix });
		} else return null;
	}
	return edits;
}

export function kartelStemRole(mediaId: unknown): KartelLaneRole | null {
	const id = String(mediaId ?? "");
	if (id.startsWith("kartel-stem-dialogue")) return "dialogue";
	if (id.startsWith("kartel-stem-background")) return "background";
	return null;
}

const allTracks = (tracks: SceneTracks): TimelineTrack[] => [...tracks.overlay, tracks.main, ...tracks.audio];
const seconds = (time: Parameters<typeof mediaTimeToSeconds>[0]["time"]) => mediaTimeToSeconds({ time });
const clampDb = (value: number) => Math.min(VOLUME_DB_MAX, Math.max(VOLUME_DB_MIN, Math.round(value * 10) / 10));

function volumeKeys(element: TimelineElement): ScalarChannel["keys"] {
	const channel = element.animations?.volume;
	return channel && isLeafChannelData(channel) && isScalarChannel(channel) ? channel.keys : [];
}

function baseVolume(element: TimelineElement): number {
	const value = (element as { params?: { volume?: unknown } }).params?.volume;
	return typeof value === "number" ? value : 0;
}

// Runs the list on the live tracks without history, then records before and after as one
// snapshot command. Returns that command (Studio's Undo checks it is still the latest step) and
// a bounded summary of what each edit touched.
type TimelineEditor = {
	scenes: { getActiveScene: () => { tracks: SceneTracks } };
	timeline: Pick<EditorCore["timeline"], "updateTracks">;
	command: Pick<EditorCore["command"], "execute" | "isRippleEnabled">;
};

export function applyKartelTimelineEdits({ editor, edits }: { editor: TimelineEditor; edits: KartelTimelineEdit[] }) {
	const tracksNow = () => editor.scenes.getActiveScene().tracks;
	const before = tracksNow();
	if (allTracks(before).some((track) => track.kartelSolo?.selected)) {
		throw new Error("Turn Solo off before applying a timeline edit so the original mix is preserved.");
	}
	const run = (command: Command) => {
		command.execute();
	};
	const applied: Record<string, unknown>[] = [];
	try {
		for (const edit of edits) {
			if (edit.kind === "ripple_delete") {
				const { startSeconds: start, endSeconds: end } = edit;
				for (const edge of [start, end]) {
					const targets = allTracks(tracksNow()).flatMap((track) => track.elements
						.filter((element) => seconds(element.startTime) < edge - 0.001 && seconds(element.startTime) + seconds(element.duration) > edge + 0.001)
						.map((element) => ({ trackId: track.id, elementId: element.id })));
					if (targets.length) run(new SplitElementsCommand({ elements: targets, splitTime: mediaTimeFromSeconds({ seconds: edge }) }));
				}
				const inside = allTracks(tracksNow()).flatMap((track) => track.elements
					.filter((element) => seconds(element.startTime) >= start - 0.001 && seconds(element.startTime) + seconds(element.duration) <= end + 0.001)
					.map((element) => ({ trackId: track.id, elementId: element.id })));
				if (inside.length) run(new DeleteElementsCommand({ elements: inside }));
				const shift = end - start;
				const updates = allTracks(tracksNow()).flatMap((track) => track.elements
					.filter((element) => seconds(element.startTime) >= end - 0.001)
					.map((element) => ({ trackId: track.id, elementId: element.id, patch: { startTime: mediaTimeFromSeconds({ seconds: seconds(element.startTime) - shift }) } as Partial<TimelineElement> })));
				if (updates.length) run(new UpdateElementsCommand({ updates }));
				applied.push({ kind: "ripple_delete", startSeconds: start, endSeconds: end, removed: inside.length });
			} else if (edit.kind === "duck") {
				let keyframes = 0;
				for (const track of tracksNow().audio) {
					for (const element of track.elements) {
						if (!("mediaId" in element) || kartelStemRole(element.mediaId) !== "background") continue;
						const elementStart = seconds(element.startTime);
						const elementEnd = elementStart + seconds(element.duration);
						const base = baseVolume(element);
						const points = new Map<number, number>();
						const add = ({ at, value }: { at: number; value: number }) => {
							const local = Math.round(Math.min(Math.max(at - elementStart, 0), elementEnd - elementStart) * 1000) / 1000;
							if (!points.has(local) || value < (points.get(local) ?? 0)) points.set(local, value);
						};
						for (const region of edit.regions) {
							if (!(region.endSeconds > elementStart) || !(region.startSeconds < elementEnd)) continue;
							add({ at: region.startSeconds - edit.rampSeconds, value: base });
							add({ at: region.startSeconds, value: clampDb(base + edit.db) });
							add({ at: region.endSeconds, value: clampDb(base + edit.db) });
							add({ at: region.endSeconds + edit.rampSeconds, value: base });
						}
						for (const [local, value] of points) {
							run(new UpsertKeyframeCommand({ trackId: track.id, elementId: element.id, propertyPath: "volume", time: mediaTimeFromSeconds({ seconds: local }), value }));
							keyframes += 1;
						}
					}
				}
				if (!keyframes) throw new Error("There is no separated music under the voice to lower.");
				applied.push({ kind: "duck", db: edit.db, regions: edit.regions.length, keyframes });
			} else if (edit.kind === "level") {
				const updates: { trackId: string; elementId: string; patch: Partial<TimelineElement> }[] = [];
				let shifted = 0;
				for (const track of tracksNow().audio) {
					for (const element of track.elements) {
						if (!("mediaId" in element) || kartelStemRole(element.mediaId) !== edit.role) continue;
						updates.push({ trackId: track.id, elementId: element.id, patch: { params: { ...(element as { params: Record<string, unknown> }).params, volume: clampDb(baseVolume(element) + edit.deltaDb) } } as Partial<TimelineElement> });
						// A ducked clip follows its keyframes, so they move by the same amount.
						for (const key of volumeKeys(element)) {
							run(new UpsertKeyframeCommand({ trackId: track.id, elementId: element.id, propertyPath: "volume", time: key.time, value: clampDb(key.value + edit.deltaDb), keyframeId: key.id }));
							shifted += 1;
						}
					}
				}
				if (!updates.length) throw new Error(`There is no separated ${edit.role === "background" ? "music" : "voice"} track to change.`);
				run(new UpdateElementsCommand({ updates }));
				applied.push({ kind: "level", role: edit.role, deltaDb: edit.deltaDb, clips: updates.length, keyframes: shifted });
			} else if (edit.kind === "mute") {
				const scene = tracksNow();
				const audio = scene.audio.map((track) => track.elements.some((element) => "mediaId" in element && kartelStemRole(element.mediaId) === edit.role)
					? { ...track, muted: edit.muted }
					: track);
				if (audio.every((track, index) => track === scene.audio[index])) throw new Error(`There is no separated ${edit.role === "background" ? "music" : "voice"} track to ${edit.muted ? "mute" : "unmute"}.`);
				editor.timeline.updateTracks({ ...scene, audio });
				applied.push({ kind: "mute", role: edit.role, muted: edit.muted });
			} else if (edit.kind === "remove_take") {
				const targets = allTracks(tracksNow()).flatMap((track) => track.elements
					.filter((element) => "mediaId" in element && String(element.mediaId).startsWith(edit.mediaIdPrefix))
					.map((element) => ({ trackId: track.id, elementId: element.id })));
				if (!targets.length) throw new Error("That take is no longer on the timeline.");
				run(new DeleteElementsCommand({ elements: targets }));
				applied.push({ kind: "remove_take", removed: targets.length });
			}
		}
	} catch (error) {
		editor.timeline.updateTracks(before);
		throw error;
	}
	const after = tracksNow();
	editor.timeline.updateTracks(before);
	const command = new TracksSnapshotCommand({ before, after });
	const ripple = editor.command.isRippleEnabled;
	editor.command.isRippleEnabled = false;
	try {
		editor.command.execute({ command });
	} finally {
		editor.command.isRippleEnabled = ripple;
	}
	return { command, applied };
}
