// Kartel Studio DF-048: OpenCut paints a video clip with its media's one thumbnail, the source's
// opening frame, so every piece of a split source looked the same. Inside Studio each piece shows
// the frame at the middle of the source range it plays. Pure seconds arithmetic with no imports,
// so the timeline and a node:test file share it.

// Frames are cached per tenth of a second of source time.
export function kartelClipFrameSeconds({ trimStartSeconds, durationSeconds, rate = 1 }: { trimStartSeconds: number; durationSeconds: number; rate?: number }): number {
	const start = Number.isFinite(trimStartSeconds) && trimStartSeconds > 0 ? trimStartSeconds : 0;
	const span = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds * (Number.isFinite(rate) && rate > 0 ? rate : 1) : 0;
	return Math.round((start + span / 2) * 10) / 10;
}

export function kartelClipFrameKey({ mediaId, seconds }: { mediaId: string; seconds: number }): string {
	return `${mediaId}@${seconds.toFixed(1)}`;
}
