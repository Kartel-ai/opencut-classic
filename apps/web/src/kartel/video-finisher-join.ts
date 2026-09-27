// Kartel Studio DF-049a: merging two shots used to relabel them while the timeline kept both
// pieces. A merge now joins the two pieces back into one: the inverse of OpenCut's split, allowed
// only for pieces a split could have made (same media, touching on the timeline and in source
// time at one constant rate, no keyframes, the same settings). Pure tick arithmetic with no
// imports, so the bridge and a node:test file share it.

export type JoinablePiece = {
	id: string;
	type: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	mediaId?: string;
	animations?: unknown;
	retime?: { rate?: number };
};

// Split rounds each side's source span to a tick once.
const TICK_TOLERANCE = 2;
const OWN_KEYS = new Set(["id", "name", "startTime", "duration", "trimStart", "trimEnd", "animations"]);

function hasAnimations(value: unknown): boolean {
	return value !== undefined && value !== null && (typeof value !== "object" || Object.keys(value).length > 0);
}

export function canJoinPieces({ left, right }: { left: JoinablePiece; right: JoinablePiece }): boolean {
	if (left.type !== right.type || !left.mediaId || left.mediaId !== right.mediaId) return false;
	if (Math.abs(left.startTime + left.duration - right.startTime) > TICK_TOLERANCE) return false;
	if (hasAnimations(left.animations) || hasAnimations(right.animations)) return false;
	const rate = left.retime?.rate ?? 1;
	if ((right.retime?.rate ?? 1) !== rate) return false;
	if (Math.abs(right.trimStart - left.trimStart - left.duration * rate) > TICK_TOLERANCE) return false;
	if (Math.abs(left.trimEnd - right.trimEnd - right.duration * rate) > TICK_TOLERANCE) return false;
	const a = left as Record<string, unknown>;
	const b = right as Record<string, unknown>;
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (!OWN_KEYS.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
	}
	return true;
}

export function joinedPiece<T extends JoinablePiece>({ left, right }: { left: T; right: T }): T {
	return { ...left, duration: left.duration + right.duration, trimEnd: right.trimEnd };
}
