// Kartel Studio RS-073: placing a generated take that is longer than its shot, and cutting a
// shot out of the source for a reference. Pure seconds arithmetic with no imports, so the bridge
// and a node:test file can share it. The bridge converts the result to OpenCut media time.

// What this editor can do beyond bridge version 1; Studio reads the list from EDITOR_READY and
// PROJECT_LOADED and sends a fit or asks for a clip only when the editor advertises it.
// RS-313: `stage-layout` is the picture alone (Studio draws the shots), from `kartel_timeline=hidden`
// at open and the `stage` layout of SET_LAYOUT after. RS-324: `sound-mix` keeps an effects-only take
// beside the dialogue and music layers, and lets levels and mute reach its Effects track.
export const VIDEO_FINISHER_EDITOR_CAPABILITIES = ["take-fit", "clip-export", "take-clip-export", "soundtrack-replacement", "stage-layout", "sound-mix"] as const;

// A fit may retime a take a little so a window of it fills the shot; more reads as slow motion
// or a skip.
export const TAKE_FIT_MIN_RATE = 0.85;
export const TAKE_FIT_MAX_RATE = 1.15;
const EPSILON = 0.0005;

export type TakeFit = { sourceStartSeconds: number; sourceEndSeconds: number };

// `undefined` when no fit was sent (place from the head, as before); `null` when one was sent and
// is invalid for this target.
export function normalizedTakeFit({ value, targetSeconds }: { value: unknown; targetSeconds: number }): TakeFit | null | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || !("sourceStartSeconds" in value) || !("sourceEndSeconds" in value)) return null;
	const record = value;
	const start = Number(record.sourceStartSeconds);
	const end = Number(record.sourceEndSeconds);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 60 * 60) return null;
	if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return null;
	const rate = (end - start) / targetSeconds;
	if (rate < TAKE_FIT_MIN_RATE - EPSILON || rate > TAKE_FIT_MAX_RATE + EPSILON) return null;
	return { sourceStartSeconds: start, sourceEndSeconds: end };
}

// The take's window over the shot: skip `trimStartSeconds`, play at `playbackRate`, and leave
// `trimEndSeconds` of the decoded take unused. Throws when the decoded take is too short.
export function takeFitGeometrySeconds({ fit, targetSeconds, sourceDurationSeconds }: {
	fit: TakeFit;
	targetSeconds: number;
	sourceDurationSeconds: number;
}) {
	if (!(sourceDurationSeconds > 0) || fit.sourceEndSeconds > sourceDurationSeconds + 0.05) {
		throw new Error("The take is shorter than the window Studio asked for. Nothing was placed.");
	}
	const played = fit.sourceEndSeconds - fit.sourceStartSeconds;
	const rawRate = played / targetSeconds;
	const playbackRate = Math.abs(rawRate - 1) < EPSILON ? 1 : Math.round(rawRate * 10000) / 10000;
	return {
		trimStartSeconds: fit.sourceStartSeconds,
		playbackRate,
		trimEndSeconds: Math.max(0, sourceDurationSeconds - fit.sourceStartSeconds - targetSeconds * playbackRate),
	};
}

// A clip of the source for a reference or an area edit: inside the source, 0.5 to 15 seconds.
export type ClipRange = { sourceStartSeconds: number; sourceEndSeconds: number };
export function normalizedClipRange({ value, sourceDurationSeconds }: { value: unknown; sourceDurationSeconds: number }): ClipRange | null {
	if (!value || typeof value !== "object" || !("sourceStartSeconds" in value) || !("sourceEndSeconds" in value)) return null;
	const record = value;
	const start = Number(record.sourceStartSeconds);
	const end = Number(record.sourceEndSeconds);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
	if (end - start < 0.5 || end - start > 15) return null;
	if (Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0 && end > sourceDurationSeconds + 0.05) return null;
	return { sourceStartSeconds: start, sourceEndSeconds: Math.min(end, sourceDurationSeconds > 0 ? sourceDurationSeconds : end) };
}

// 2026-10-07 (fixes that stack): a clip may be cut from a take already placed on the timeline
// instead of the source, so a second fix on a shot starts from the kept take. Only a placed
// repair take is named this way; anything else is the source.
export function clipMediaId(value: unknown): string | null {
	if (!value || typeof value !== "object" || !("mediaId" in value)) return null;
	const mediaId = (value as { mediaId?: unknown }).mediaId;
	return typeof mediaId === "string" && /^kartel-repair-[A-Za-z0-9_-]{1,200}$/.test(mediaId) ? mediaId : null;
}

// The clip's frame size: the source's, or scaled so its short edge is at most `maxShortEdge`,
// keeping the aspect and even dimensions for H.264. Null when no scaling is needed.
export function clipOutputSize({ width, height, maxShortEdge }: { width: number; height: number; maxShortEdge: number }) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
	if (!Number.isFinite(maxShortEdge) || maxShortEdge < 16) return null;
	const short = Math.min(width, height);
	if (short <= maxShortEdge) return null;
	const scale = maxShortEdge / short;
	const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
	return { width: even(width), height: even(height) };
}
