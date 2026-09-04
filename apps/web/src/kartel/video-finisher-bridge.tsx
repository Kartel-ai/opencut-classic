"use client";

import { useEffect, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { frameRateToFloat } from "@/fps/utils";
import { getClipTimeAtSourceTime, getSourceTimeAtClipTime } from "@/retime/resolve";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import {
	cacheVideoFinisherExport,
	readCachedVideoFinisherExport,
	releaseCachedVideoFinisherExport,
} from "./video-finisher-export-cache";
import {
	buildElementFromMedia,
	canElementBeHidden,
	canElementHaveAudio,
} from "@/timeline/element-utils";
import { toElementDurationTicks } from "@/timeline/creation";
import { updateSceneInArray } from "@/timeline/scenes";
import type {
	Bookmark,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import type { TProject } from "@/project/types";
import {
	buildVideoFinisherBridgeMessage,
	VIDEO_FINISHER_BRIDGE,
	VIDEO_FINISHER_BRIDGE_VERSION,
	VIDEO_FINISHER_HOST_MESSAGE_TYPES,
} from "./video-finisher-protocol";
import type { VideoFinisherHostMessage } from "./video-finisher-protocol";
import { createProjectLoadQueue, projectMediaForHost, requireProjectMedia } from "./video-finisher-media";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const OPEN_CUT_COMMIT = /^[0-9a-f]{40}$/.test(
	process.env.NEXT_PUBLIC_KARTEL_OPEN_CUT_COMMIT ?? "",
)
	? (process.env.NEXT_PUBLIC_KARTEL_OPEN_CUT_COMMIT ?? "")
	: "";

export function videoFinisherExportFrameRate(
	frameRate: Parameters<typeof frameRateToFloat>[0],
) {
	return frameRateToFloat(frameRate);
}

export type HostProject = {
	source?: {
		assetId?: string;
		versionId?: string;
		name?: string;
		src?: string;
		mimeType?: string;
		bytes?: ArrayBuffer;
		byteSize?: number;
		sha256?: string;
	};
	document?: unknown;
	media?: { id: string; file: File; sha256: string }[];
	issueIds?: string[];
	repairs?: unknown;
};

export type RepairInsertion = {
	semanticRole:
		| "replacement_voice"
		| "replacement_shot"
		| "insert_shot"
		| "keyframe"
		| "extended_shot";
	clipId: string;
	startSeconds: number;
	endSeconds: number;
	candidate: {
		assetId: string;
		versionId: string;
		name: string;
		src: string;
		mimeType: string;
		byteSize: number;
		sha256: string;
		durationSeconds: number;
	};
};

export function repairMediaId(operationId: string): string {
	return `kartel-repair-${operationId}`.slice(0, 240);
}

function findRepairElement({
	tracks,
	mediaId,
}: {
	tracks: readonly TimelineTrack[];
	mediaId: string;
}): {
	id: string;
	mediaId: string;
	trackId: string;
	element: TimelineElement;
} | null {
	for (const track of tracks) {
		for (const element of track.elements) {
			if ("mediaId" in element && element.mediaId === mediaId) {
				return { id: element.id, mediaId, trackId: track.id, element };
			}
		}
	}
	return null;
}

export function repairPreviewUpdate({
	tracks,
	mediaId,
	silenced,
}: {
	tracks: readonly TimelineTrack[];
	mediaId: string;
	silenced: boolean;
}): {
	trackId: string;
	elementId: string;
	updates: Partial<TimelineElement>;
} | null {
	const repair = findRepairElement({ tracks, mediaId });
	if (!repair) return null;
	const updates = {
		...(canElementBeHidden(repair.element) ? { hidden: silenced } : {}),
		...(canElementHaveAudio(repair.element)
			? { params: { ...repair.element.params, muted: silenced } }
			: {}),
	} as Partial<TimelineElement>;
	return { trackId: repair.trackId, elementId: repair.id, updates };
}

export type RepairCandidate = RepairInsertion["candidate"];

// One exact Studio media candidate: Asset Library identity, a transport URL, and the bytes'
// declared MIME, size, and checksum that the editor re-verifies before import.
export function normalizedCandidate({ value, expectedMIME }: {
	value: unknown;
	expectedMIME: string | readonly string[];
}): RepairCandidate | null {
	if (!isRecord(value)) return null;
	const candidate = value;
	const mimeType = String(candidate.mimeType ?? "").toLowerCase();
	const durationSeconds = Number(candidate.durationSeconds);
	const byteSize = Number(candidate.byteSize);
	if (
		!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 6 * 60 * 60 ||
		!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_SOURCE_BYTES ||
		typeof candidate.assetId !== "string" || candidate.assetId.length < 1 || candidate.assetId.length > 160 ||
		typeof candidate.versionId !== "string" || candidate.versionId.length < 1 || candidate.versionId.length > 160 ||
		typeof candidate.name !== "string" || candidate.name.trim().length < 1 || candidate.name.length > 255 ||
		typeof candidate.src !== "string" ||
		typeof candidate.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(candidate.sha256) ||
		(Array.isArray(expectedMIME) ? !expectedMIME.includes(mimeType) : mimeType !== expectedMIME)
	) return null;
	return {
		assetId: candidate.assetId,
		versionId: candidate.versionId,
		name: candidate.name.trim(),
		src: candidate.src,
		mimeType,
		byteSize,
		sha256: candidate.sha256,
		durationSeconds,
	};
}

export function normalizedRepairInsertion(value: unknown): RepairInsertion | null {
	if (!isRecord(value)) return null;
	const rawSemanticRole = String(value.semanticRole ?? "");
	let semanticRole: RepairInsertion["semanticRole"];
	switch (rawSemanticRole) {
		case "replacement_voice":
		case "replacement_shot":
		case "insert_shot":
		case "keyframe":
		case "extended_shot":
			semanticRole = rawSemanticRole;
			break;
		default:
			return null;
	}
	const startSeconds = Number(value.startSeconds);
	const endSeconds = Number(value.endSeconds);
	// An operator recording is PCM WAV; a synthesized voice line arrives from the provider as MP3.
	const expectedMIME = semanticRole === "replacement_voice"
		? ["audio/wav", "audio/mpeg"]
		: semanticRole === "keyframe"
			? ["image/png", "image/jpeg", "image/webp"]
			: "video/mp4";
	const candidate = normalizedCandidate({ value: value.candidate, expectedMIME });
	if (
		!candidate ||
		typeof value.clipId !== "string" || value.clipId.length < 1 || value.clipId.length > 160 ||
		!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > 6 * 60 * 60
	) return null;
	if (semanticRole !== "keyframe" && candidate.durationSeconds + 0.05 < endSeconds - startSeconds) return null;
	return {
		semanticRole,
		clipId: value.clipId,
		startSeconds,
		endSeconds,
		candidate,
	};
}

// Breakdown request: the shots Studio detected (interior cut times on the source clip, with the
// labels each resulting piece takes) and any separated audio layers that are ready to sit on
// their own tracks. Splits are non-destructive timeline edits; the source media is untouched.
export const MAX_BREAKDOWN_SHOTS = 120;
export type HostBreakdown = {
	sourceClipId: string | null;
	cuts: number[];
	shots: { id: string; label: string; startSeconds: number; endSeconds: number }[];
	stems: { role: "dialogue" | "background"; label: string; candidate: RepairCandidate }[];
};

// Stems arrive as the provider's MP3 (isolated voice) or a browser-derived PCM WAV (background).
const STEM_MIME_TYPES = ["audio/mpeg", "audio/wav"] as const;

export function normalizedBreakdown(value: unknown): HostBreakdown | null {
	if (!isRecord(value) || !Array.isArray(value.cuts) || !Array.isArray(value.shots) || !Array.isArray(value.stems)) return null;
	if (value.cuts.length >= MAX_BREAKDOWN_SHOTS || value.shots.length > MAX_BREAKDOWN_SHOTS || value.stems.length > 3) return null;
	const cuts: number[] = [];
	for (const raw of value.cuts) {
		const seconds = Number(raw);
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 6 * 60 * 60 || (cuts.length && seconds <= cuts[cuts.length - 1])) return null;
		cuts.push(seconds);
	}
	const shots: HostBreakdown["shots"] = [];
	for (const raw of value.shots) {
		if (!isRecord(raw)) return null;
		const startSeconds = Number(raw.startSeconds);
		const endSeconds = Number(raw.endSeconds);
		if (
			typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > 40 ||
			typeof raw.label !== "string" || raw.label.trim().length < 1 || raw.label.length > 80 ||
			!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > 6 * 60 * 60
		) return null;
		shots.push({ id: raw.id, label: raw.label.trim(), startSeconds, endSeconds });
	}
	const stems: HostBreakdown["stems"] = [];
	for (const raw of value.stems) {
		if (!isRecord(raw)) return null;
		const role = String(raw.role ?? "");
		if (role !== "dialogue" && role !== "background") return null;
		if (stems.some((stem) => stem.role === role)) return null;
		const candidate = normalizedCandidate({ value: raw.candidate, expectedMIME: STEM_MIME_TYPES });
		if (!candidate || typeof raw.label !== "string" || raw.label.trim().length < 1 || raw.label.length > 80) return null;
		stems.push({ role, label: raw.label.trim(), candidate });
	}
	const sourceClipId = typeof value.sourceClipId === "string" && value.sourceClipId.length >= 1 && value.sourceClipId.length <= 160
		? value.sourceClipId
		: null;
	return { sourceClipId, cuts, shots, stems };
}

export function stemMediaId(stem: HostBreakdown["stems"][number]): string {
	return `kartel-stem-${stem.role}-${encodeURIComponent(stem.candidate.assetId)}-${encodeURIComponent(stem.candidate.versionId)}`;
}

// The breakdown describes immutable source time; OpenCut stores timeline time.
// Use the same retime conversion as its split command, including an existing trim.
export function breakdownSourceRange(element: TimelineElement) {
	const retime = "retime" in element ? element.retime : undefined;
	const startSeconds = mediaTimeToSeconds({ time: element.trimStart });
	return {
		startSeconds,
		endSeconds: startSeconds + getSourceTimeAtClipTime({ clipTime: mediaTimeToSeconds({ time: element.duration }), retime }),
	};
}

export function breakdownCutTimelineSeconds({ element, sourceSeconds }: { element: TimelineElement; sourceSeconds: number }): number | null {
	const range = breakdownSourceRange(element);
	const retime = "retime" in element ? element.retime : undefined;
	const offset = getClipTimeAtSourceTime({ sourceTime: sourceSeconds - range.startSeconds, retime });
	const duration = mediaTimeToSeconds({ time: element.duration });
	if (!Number.isFinite(offset) || offset <= 0.011 || offset >= duration - 0.011) return null;
	return mediaTimeToSeconds({ time: element.startTime }) + offset;
}

export function breakdownSourceAtTimeline({ element, timelineSeconds }: { element: TimelineElement; timelineSeconds: number }): number | null {
	const offset = timelineSeconds - mediaTimeToSeconds({ time: element.startTime });
	if (!Number.isFinite(offset) || offset < 0 || offset >= mediaTimeToSeconds({ time: element.duration })) return null;
	return breakdownSourceRange(element).startSeconds + getSourceTimeAtClipTime({
		clipTime: offset, retime: "retime" in element ? element.retime : undefined,
	});
}

function selectionCoordinates({ element, sourceMediaId }: { element: TimelineElement; sourceMediaId: string | null }) {
	const source = element.type === "video" && element.mediaId === sourceMediaId ? breakdownSourceRange(element) : null;
	return {
		clipId: element.id,
		startSeconds: mediaTimeToSeconds({ time: element.startTime }),
		endSeconds: mediaTimeToSeconds({ time: addMediaTime({ a: element.startTime, b: element.duration }) }),
		sourceStartSeconds: source?.startSeconds ?? null,
		sourceEndSeconds: source?.endSeconds ?? null,
	};
}

export function videoFinisherSourceLayout({ tracks, sourceMediaId }: { tracks: readonly TimelineTrack[]; sourceMediaId: string | null }) {
	return {
		durationSeconds: Math.max(0, ...tracks.flatMap((track) => track.elements.map((element) => mediaTimeToSeconds({ time: addMediaTime({ a: element.startTime, b: element.duration }) })))),
		clips: tracks.flatMap((track) => track.elements
			.filter((element) => sourceMediaId !== null && element.type === "video" && element.mediaId === sourceMediaId)
			.map((element) => selectionCoordinates({ element, sourceMediaId }))),
	};
}

export function breakdownStemGeometry({ piece, stemDurationSeconds }: { piece: TimelineElement; stemDurationSeconds: number }) {
	const range = breakdownSourceRange(piece);
	if (piece.type !== "video" || !Number.isFinite(stemDurationSeconds) || stemDurationSeconds < range.endSeconds) {
		throw new Error("The separated layer does not cover the exact source range. Original audio is unchanged.");
	}
	return {
		startTime: piece.startTime,
		duration: piece.duration,
		trimStart: piece.trimStart,
		trimEnd: mediaTimeFromSeconds({ seconds: stemDurationSeconds - range.endSeconds }),
		sourceDuration: mediaTimeFromSeconds({ seconds: stemDurationSeconds }),
		retime: piece.retime,
	};
}

function findBreakdownStemElement({ tracks, mediaId, piece }: { tracks: readonly TimelineTrack[]; mediaId: string; piece: TimelineElement }) {
	for (const track of tracks) {
		for (const element of track.elements) {
			if (element.type === "audio" && "mediaId" in element && element.mediaId === mediaId &&
				element.startTime === piece.startTime && element.duration === piece.duration && element.trimStart === piece.trimStart &&
				(element.retime?.rate ?? 1) === ("retime" in piece ? piece.retime?.rate ?? 1 : 1)) {
				return { id: element.id, trackId: track.id, mutedTrack: "muted" in track && track.muted };
			}
		}
	}
	return null;
}

// Exact clip selection stays authoritative. Source coordinates never fall back to
// an unrelated clip at the same timeline position.
export type RangeSelection = { clipId: string | null; startSeconds: number | null; sourceSeconds: number | null };

export function normalizedRangeSelection(value: unknown): RangeSelection | null {
	if (!isRecord(value)) return null;
	const clipId = typeof value.clipId === "string" && value.clipId.length >= 1 && value.clipId.length <= 160 ? value.clipId : null;
	const startSeconds = value.startSeconds === undefined || value.startSeconds === null ? null : Number(value.startSeconds);
	const sourceSeconds = value.sourceSeconds === undefined || value.sourceSeconds === null ? null : Number(value.sourceSeconds);
	if (startSeconds !== null && (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 6 * 60 * 60)) return null;
	if (sourceSeconds !== null && (!Number.isFinite(sourceSeconds) || sourceSeconds < 0 || sourceSeconds > 6 * 60 * 60 || startSeconds !== null)) return null;
	if (!clipId && startSeconds === null && sourceSeconds === null) return null;
	return { clipId, startSeconds, sourceSeconds };
}

export function studioOrigin(
	raw = String(process.env.NEXT_PUBLIC_KARTEL_STUDIO_ORIGIN ?? ""),
): string | null {
	raw = raw.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		const valid =
			!url.username &&
			!url.password &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash &&
			(url.protocol === "https:" || (url.protocol === "http:" && loopback));
		return valid ? url.origin : null;
	} catch {
		return null;
	}
}

export function normalizedProjectDocument({
	value,
	projectId,
}: {
	value: unknown;
	projectId: string;
}): TProject | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- guarded versioned bridge document
	const project = value as TProject;
	if (
		project.metadata?.id !== projectId ||
		typeof project.metadata.name !== "string" ||
		!Array.isArray(project.scenes) ||
		!project.settings ||
		typeof project.currentSceneId !== "string"
	)
		return null;
	const createdAt = new Date(project.metadata.createdAt);
	const updatedAt = new Date(project.metadata.updatedAt);
	if (
		!Number.isFinite(createdAt.getTime()) ||
		!Number.isFinite(updatedAt.getTime())
	)
		return null;
	const scenes = project.scenes.map((scene) => {
		const sceneCreatedAt = new Date(scene.createdAt);
		const sceneUpdatedAt = new Date(scene.updatedAt);
		if (
			!scene.id ||
			!scene.tracks ||
			!Number.isFinite(sceneCreatedAt.getTime()) ||
			!Number.isFinite(sceneUpdatedAt.getTime())
		) {
			throw new Error("Studio returned an invalid OpenCut scene.");
		}
		return { ...scene, createdAt: sceneCreatedAt, updatedAt: sceneUpdatedAt };
	});
	return {
		...project,
		metadata: { ...project.metadata, createdAt, updatedAt },
		scenes,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Compare request: play one bounded range with the repair element audible/visible (repaired) or
// silenced/hidden (original), or stop. The preview uses OpenCut's transient overlay and is never
// committed to the project.
export type PreviewRange = {
	mode: "original" | "repaired" | "stop";
	mediaId: string;
	startSeconds: number;
	endSeconds: number;
};

export function normalizedPreviewRange(value: unknown): PreviewRange | null {
	if (!isRecord(value)) return null;
	const mode = String(value.mode ?? "");
	if (mode !== "original" && mode !== "repaired" && mode !== "stop") return null;
	const startSeconds = Number(value.startSeconds);
	const endSeconds = Number(value.endSeconds);
	if (
		typeof value.mediaId !== "string" || value.mediaId.length < 1 || value.mediaId.length > 240 ||
		!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > 6 * 60 * 60
	) return null;
	return { mode, mediaId: value.mediaId, startSeconds, endSeconds };
}

// Studio-owned timeline markers: one bookmark per recorded issue or note, coloured by category,
// carrying the operator's own sentence. Operator bookmarks are never touched.
export const KARTEL_MARKER_PREFIX = "Kartel · ";
const MARKER_COLORS = new Set(["dialogue", "artifact", "shot", "pacing", "mix"]);

export type HostMarker = {
	id: string;
	startSeconds: number;
	endSeconds: number;
	note: string;
	category: "dialogue" | "artifact" | "shot" | "pacing" | "mix";
};

export function normalizedMarkers(value: unknown): HostMarker[] | null {
	if (!isRecord(value) || !Array.isArray(value.markers) || value.markers.length > 200) return null;
	const markers: HostMarker[] = [];
	for (const entry of value.markers) {
		if (!isRecord(entry)) return null;
		const startSeconds = Number(entry.startSeconds);
		const endSeconds = Number(entry.endSeconds);
		const category = String(entry.category ?? "");
		if (
			typeof entry.id !== "string" || entry.id.length < 1 || entry.id.length > 200 ||
			!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds < startSeconds || endSeconds > 6 * 60 * 60 ||
			typeof entry.note !== "string" || entry.note.length > 600 || !MARKER_COLORS.has(category)
		) return null;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated against MARKER_COLORS above
		markers.push({ id: entry.id, startSeconds, endSeconds, note: entry.note.trim(), category: category as HostMarker["category"] });
	}
	return markers;
}

const MARKER_COLOR_BY_CATEGORY: Record<HostMarker["category"], string> = {
	dialogue: "#2f6fed",
	artifact: "#c0392b",
	shot: "#8e44ad",
	pacing: "#d68910",
	mix: "#138d75",
};

export function kartelMarkerBookmarks({
	markers,
	existing,
}: {
	markers: HostMarker[];
	existing: Bookmark[];
}): Bookmark[] {
	const operatorBookmarks = existing.filter((bookmark) => !String(bookmark.note ?? "").startsWith(KARTEL_MARKER_PREFIX));
	const kartel = markers.map((marker) => ({
		time: mediaTimeFromSeconds({ seconds: marker.startSeconds }),
		note: `${KARTEL_MARKER_PREFIX}${marker.note || marker.category}`,
		color: MARKER_COLOR_BY_CATEGORY[marker.category],
		duration: marker.endSeconds > marker.startSeconds
			? mediaTimeFromSeconds({ seconds: marker.endSeconds - marker.startSeconds })
			: undefined,
	}));
	return [...operatorBookmarks, ...kartel];
}

function isHostMessage(value: unknown): value is VideoFinisherHostMessage {
	if (!isRecord(value)) return false;
	const message = value;
	return (
		message.bridge === VIDEO_FINISHER_BRIDGE &&
		message.version === VIDEO_FINISHER_BRIDGE_VERSION &&
		(VIDEO_FINISHER_HOST_MESSAGE_TYPES as readonly string[]).includes(String(message.type)) &&
		typeof message.nonce === "string" &&
		typeof message.projectId === "string" &&
		Number.isInteger(message.revision) &&
		typeof message.operationId === "string"
	);
}

async function sha256Hex(blob: Blob): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await blob.arrayBuffer(),
	);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

function safeSourceName(name: unknown): string {
	const value = String(name ?? "source-video.mp4")
		.trim()
		.replace(/[\\/\r\n]/g, "-")
		.slice(0, 240);
	return /\.(mp4|mov|webm)$/i.test(value)
		? value
		: `${value || "source-video"}.mp4`;
}

function safeCandidateName({ name, mimeType }: { name: string; mimeType: string }): string {
	const value = name.trim().replace(/[\\/\r\n]/g, "-").slice(0, 240);
	const extension = mimeType === "audio/wav" ? ".wav"
		: mimeType === "audio/mpeg" ? ".mp3"
		: mimeType === "image/png" ? ".png"
			: mimeType === "image/jpeg" ? ".jpg"
				: mimeType === "image/webp" ? ".webp" : ".mp4";
	return value.toLowerCase().endsWith(extension) ? value : `${value || "repair-candidate"}${extension}`;
}

async function repairCandidateFile(insertion: { candidate: RepairCandidate }): Promise<File> {
	const candidate = insertion.candidate;
	let url: URL;
	try {
		url = new URL(candidate.src);
	} catch {
		throw new Error("Studio provided an invalid repair-candidate transport.");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
		throw new Error("Studio provided an unsafe repair-candidate transport.");
	}
	const response = await fetch(url, { credentials: "omit", redirect: "error" });
	if (!response.ok) throw new Error("The authorized repair candidate could not be loaded.");
	const blob = await response.blob();
	if (blob.type !== candidate.mimeType || blob.size !== candidate.byteSize || await sha256Hex(blob) !== candidate.sha256) {
		throw new Error("The repair candidate failed its exact media identity check.");
	}
	return new File([blob], safeCandidateName({ name: candidate.name, mimeType: candidate.mimeType }), {
		type: candidate.mimeType,
		lastModified: Date.now(),
	});
}

export async function sourceFile(project: HostProject): Promise<File> {
	const source = project.source;
	if (!source?.versionId)
		throw new Error("Studio did not provide an exact playable source version.");
	if (source.bytes instanceof ArrayBuffer) {
		const mimeType = String(source.mimeType ?? "").toLowerCase();
		if (
			mimeType !== "video/mp4" ||
			source.bytes.byteLength < 1 ||
			source.bytes.byteLength > MAX_SOURCE_BYTES ||
			!Number.isSafeInteger(source.byteSize) ||
			source.byteSize !== source.bytes.byteLength ||
			!/^[0-9a-f]{64}$/.test(source.sha256 ?? "")
		) {
			throw new Error("The transferred source failed its bounded media identity check.");
		}
		const blob = new Blob([source.bytes], { type: mimeType });
		if ((await sha256Hex(blob)) !== source.sha256) {
			throw new Error("The transferred source checksum changed before OpenCut import.");
		}
		return new File([blob], safeSourceName(source.name), {
			type: mimeType,
			lastModified: Date.now(),
		});
	}
	if (!source.src)
		throw new Error("Studio did not provide an exact playable source version.");
	let url: URL;
	try {
		url = new URL(source.src);
	} catch {
		throw new Error("Studio provided an invalid source transport.");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.username ||
		url.password ||
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
	) {
		throw new Error("Studio provided an unsafe source transport.");
	}
	const response = await fetch(url, { credentials: "omit", redirect: "error" });
	if (!response.ok)
		throw new Error("The authorized source version could not be loaded.");
	const blob = await response.blob();
	if (
		!blob.type.startsWith("video/") ||
		blob.size < 1 ||
		blob.size > MAX_SOURCE_BYTES ||
		(Number.isSafeInteger(source.byteSize) && source.byteSize !== blob.size)
	) {
		throw new Error("The source version failed its bounded media check.");
	}
	if (
		/^[0-9a-f]{64}$/.test(source.sha256 ?? "") &&
		(await sha256Hex(blob)) !== source.sha256
	) {
		throw new Error(
			"The source version checksum changed before OpenCut import.",
		);
	}
	return new File([blob], safeSourceName(source.name), {
		type: blob.type,
		lastModified: Date.now(),
	});
}

export function KartelVideoFinisherBridge({
	projectId,
}: {
	projectId: string;
}) {
	const editor = useEditor();
	const hostOrigin = studioOrigin();
	const identityRef = useRef<Pick<
		VideoFinisherHostMessage,
		"nonce" | "projectId" | "revision" | "operationId"
	> | null>(null);
	const applyingRef = useRef(false);
	const loadQueueRef = useRef(createProjectLoadQueue());
	const sourceLoadsRef = useRef(new Map<string, Promise<MediaAsset>>());
	const sourceMediaIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!hostOrigin || window.parent === window) return;
		const query = new URLSearchParams(window.location.search);
		const bridgeNonce = query.get("kartel_nonce") ?? "";
		const bridgeProject = query.get("kartel_project") ?? "";
		if (!bridgeNonce || bridgeNonce.length > 240 || bridgeProject !== projectId) return;
		const post = ({
			type,
			identity,
			payload = null,
		}: {
			type: string;
			identity: Pick<
				VideoFinisherHostMessage,
				"nonce" | "projectId" | "revision" | "operationId"
			>;
			payload?: unknown;
		}) => {
			window.parent.postMessage(
				buildVideoFinisherBridgeMessage({ type, identity, payload }),
				hostOrigin,
			);
		};

		const ensureSource = async (project: HostProject) => {
			const versionId = project.source?.versionId;
			if (!versionId)
				throw new Error("The source version identity is missing.");
			const existing = editor.media
				.getAssets()
				.find((asset) => asset.id === versionId);
			if (existing) return existing;
			const pending = sourceLoadsRef.current.get(versionId);
			if (pending) return pending;
			const loading = (async () => {
				const file = await sourceFile(project);
				const [processed] = await processMediaAssets({ files: [file] });
				if (!processed)
					throw new Error("OpenCut could not decode the source version.");
				const afterProcessing = editor.media
					.getAssets()
					.find((asset) => asset.id === versionId);
				if (afterProcessing) return afterProcessing;
				const created = await editor.media.addMediaAsset({
					projectId,
					asset: { ...processed, id: versionId },
				});
				if (!created)
					throw new Error("OpenCut could not retain the source version.");
				return created;
			})();
			sourceLoadsRef.current.set(versionId, loading);
			try {
				return await loading;
			} finally {
				if (sourceLoadsRef.current.get(versionId) === loading) {
					sourceLoadsRef.current.delete(versionId);
				}
			}
		};

		const load = async (message: VideoFinisherHostMessage) => {
			if (!OPEN_CUT_COMMIT)
				throw new Error("This OpenCut build is missing its exact Git commit identity.");
			const project = (message.payload ?? {}) as HostProject;
			const document = normalizedProjectDocument({
				value: project.document,
				projectId,
			});
			applyingRef.current = true;
			try {
				if (project.document && !document)
					throw new Error(
						"Studio returned an invalid OpenCut project document.",
					);
				if (document) {
					await storageService.saveProject({ project: document });
					await editor.project.loadProject({ id: projectId, preserveActiveScene: true });
				}
				const source = await ensureSource(project);
				sourceMediaIdRef.current = source.id;
				// Rebuild imported dependencies from Studio custody, including in a fresh browser.
				if (project.media) {
					if (!Array.isArray(project.media) || project.media.length > 64) throw new Error("Invalid project media manifest.");
					for (const item of project.media) {
						if (!item.id || item.id === source.id || !(item.file instanceof Blob) || item.file.size > MAX_SOURCE_BYTES
							|| await sha256Hex(item.file) !== item.sha256) throw new Error("Project media failed its exact checksum.");
						const existing = editor.media.getAssets().find((asset) => asset.id === item.id);
						if (existing && await sha256Hex(existing.file) === item.sha256) continue;
						if (existing) throw new Error("Cached project media changed identity.");
						const [processed] = await processMediaAssets({ files: [item.file] });
						if (!processed || !await editor.media.addMediaAsset({ projectId, asset: { ...processed, id: item.id } })) {
							throw new Error("OpenCut could not restore required project media.");
						}
					}
				}
				if (document) requireProjectMedia({ scenes: document.scenes, assets: editor.media.getAssets() });
				// Studio owns the title: the OpenCut project carries the exact source name, never
				// "Untitled Project", so the embedded editor reads as the operator's video.
				const desiredName = String(project.source?.name ?? "").trim().slice(0, 240);
				const activeProject = editor.project.getActive();
				if (desiredName && activeProject && activeProject.metadata.name !== desiredName) {
					await editor.project.renameProject({ id: projectId, name: desiredName });
				}
				const activeScene = editor.scenes.getActiveScene();
				const hasTimelineSource =
					activeScene.tracks.main.elements.some(
						(element) => "mediaId" in element && element.mediaId === source.id,
					) ||
					activeScene.tracks.overlay.some((track) =>
						track.elements.some(
							(element) =>
								"mediaId" in element && element.mediaId === source.id,
						),
					);
				if (!document && !hasTimelineSource) {
					editor.timeline.insertElement({
						placement: {
							mode: "explicit",
							trackId: activeScene.tracks.main.id,
						},
						element: buildElementFromMedia({
							mediaId: source.id,
							mediaType: source.type,
							name: source.name,
							duration: toElementDurationTicks({ seconds: source.duration }),
							startTime: ZERO_MEDIA_TIME,
						}),
					});
				}
				identityRef.current = message;
				post({
					type: "PROJECT_LOADED",
					identity: message,
					payload: {
						instanceId: projectId,
						loadCount: 1,
						playhead: mediaTimeToSeconds({
							time: editor.playback.getCurrentTime(),
						}),
						issueCount: project.issueIds?.length ?? 0,
						repairMode: project.repairs ? "prepared" : "none",
						openCutCommit: OPEN_CUT_COMMIT,
						sourceLayout: sourceLayout(),
					},
				});
			} finally {
				applyingRef.current = false;
			}
		};

		const save = async (message: VideoFinisherHostMessage) => {
			await editor.save.flush();
			const stored = await storageService.loadProject({ id: projectId });
			if (!stored) throw new Error("OpenCut could not read the saved project.");
			identityRef.current = message;
			post({
				type: "PROJECT_SAVED",
				identity: message,
				payload: {
          // The generated preview is a disposable cache, sometimes larger than
          // Studio's entire document limit. Timeline/media identity stays intact.
          document: { ...stored.project, metadata: { ...stored.project.metadata, thumbnail: undefined } },
					media: projectMediaForHost({ project: stored.project, assets: editor.media.getAssets(), sourceId: sourceMediaIdRef.current }),
					openCutCommit: OPEN_CUT_COMMIT,
				},
			});
		};

		const insertReplacement = async (message: VideoFinisherHostMessage) => {
			const insertion = normalizedRepairInsertion(message.payload);
			if (!insertion) throw new Error("Studio returned an invalid repair insertion contract.");
			const activeScene = editor.scenes.getActiveScene();
			const tracks = [...activeScene.tracks.overlay, activeScene.tracks.main, ...activeScene.tracks.audio];
			if (!tracks.some((track) => track.elements.some((element) => element.id === insertion.clipId))) {
				throw new Error("The exact source clip is no longer present in this project revision.");
			}
			const mediaId = repairMediaId(message.operationId);
			const existing = findRepairElement({ tracks, mediaId });
			if (existing) {
				post({
					type: "REPLACEMENT_INSERTED",
					identity: message,
					payload: { elementId: existing.id, mediaId, replayed: true },
				});
				return;
			}
			const file = await repairCandidateFile(insertion);
			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed) throw new Error("OpenCut could not decode the repair candidate.");
			const created = await editor.media.addMediaAsset({
				projectId,
				asset: { ...processed, id: mediaId },
			});
			if (!created) throw new Error("OpenCut could not retain the repair candidate.");
			if (
				(insertion.semanticRole === "replacement_voice" && created.type !== "audio") ||
				(insertion.semanticRole !== "replacement_voice" && insertion.semanticRole !== "keyframe" && created.type !== "video") ||
				(insertion.semanticRole === "keyframe" && created.type !== "image")
			) throw new Error("The decoded repair candidate does not match its declared role.");
			const targetDuration = insertion.endSeconds - insertion.startSeconds;
			const element = buildElementFromMedia({
				mediaId: created.id,
				mediaType: created.type,
				name: created.name,
				duration: toElementDurationTicks({ seconds: targetDuration }),
				startTime: mediaTimeFromSeconds({ seconds: insertion.startSeconds }),
				buffer: created.type === "audio"
					? new AudioBuffer({ length: 1, sampleRate: 44_100 })
					: undefined,
			});
			applyingRef.current = true;
			try {
				editor.timeline.insertElement({
					element,
					placement: { mode: "auto", trackType: created.type === "audio" ? "audio" : "video" },
				});
				const insertedScene = editor.scenes.getActiveScene();
				const inserted = findRepairElement({
					tracks: [...insertedScene.tracks.overlay, insertedScene.tracks.main, ...insertedScene.tracks.audio],
					mediaId,
				});
				if (!inserted) throw new Error("OpenCut could not confirm the inserted repair candidate.");
				await editor.save.flush();
				identityRef.current = message;
				post({
					type: "REPLACEMENT_INSERTED",
					identity: message,
					payload: {
						elementId: inserted.id,
						mediaId: created.id,
						assetId: insertion.candidate.assetId,
						assetVersionId: insertion.candidate.versionId,
						semanticRole: insertion.semanticRole,
						startSeconds: insertion.startSeconds,
						endSeconds: insertion.endSeconds,
						replayed: false,
					},
				});
			} finally {
				applyingRef.current = false;
			}
		};

		const observeReplacement = async (message: VideoFinisherHostMessage) => {
			const mediaId = repairMediaId(message.operationId);
			const activeScene = editor.scenes.getActiveScene();
			const tracks = [...activeScene.tracks.overlay, activeScene.tracks.main, ...activeScene.tracks.audio];
			const existing = findRepairElement({ tracks, mediaId });
			post({
				type: "REPLACEMENT_OBSERVED",
				identity: message,
				payload: { present: Boolean(existing), elementId: existing?.id ?? null, mediaId },
			});
		};

		let previewStop: (() => void) | null = null;
		let repairPreviewElementId: string | null = null;
		const mutateRepairPreview = (mutate: () => void) => {
			// Timeline preview notifications normally participate in autosave. Pause save delivery
			// while applying or discarding this host-owned compare overlay so it stays ephemeral.
			editor.save.pause();
			applyingRef.current = true;
			try {
				mutate();
			} finally {
				applyingRef.current = false;
				editor.save.resume();
			}
		};
		const clearRepairPreview = () => {
			if (!repairPreviewElementId) return;
			const elementId = repairPreviewElementId;
			mutateRepairPreview(() =>
				editor.timeline.discardPreviewElements({ elementIds: [elementId] }),
			);
			repairPreviewElementId = null;
		};
		const setRepairElementSilenced = ({
			mediaId,
			silenced,
		}: {
			mediaId: string;
			silenced: boolean;
		}) => {
			const scene = editor.scenes.getActiveScene();
			clearRepairPreview();
			if (editor.timeline.isPreviewActive()) {
				throw new Error("Finish the current editor interaction before comparing this repair.");
			}
			if (!silenced) return;
			const update = repairPreviewUpdate({
				tracks: [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio],
				mediaId,
				silenced,
			});
			if (!update) {
				throw new Error("The repair to compare is not present in this project revision.");
			}
			mutateRepairPreview(() => editor.timeline.previewElements({ updates: [update] }));
			repairPreviewElementId = update.elementId;
		};
		const previewRange = async (message: VideoFinisherHostMessage) => {
			const preview = normalizedPreviewRange(message.payload);
			if (!preview) throw new Error("Studio returned an invalid compare request.");
			previewStop?.();
			previewStop = null;
			if (preview.mode === "stop") {
				editor.playback.pause();
				clearRepairPreview();
				post({ type: "PREVIEW_STATE", identity: message, payload: { mode: "stop", playing: false } });
				return;
			}
			const scene = editor.scenes.getActiveScene();
			const tracks = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
			if (!findRepairElement({ tracks, mediaId: preview.mediaId })) {
				throw new Error("The repair to compare is not present in this project revision.");
			}
			setRepairElementSilenced({
				mediaId: preview.mediaId,
				silenced: preview.mode === "original",
			});
			editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: preview.startSeconds }) });
			editor.playback.play();
			// Stopping pauses playback, which notifies playback subscribers again: the guard makes the
			// stop idempotent so the listener never re-enters itself.
			let stopped = false;
			let sawPlaying = false;
			let unsubscribe: (() => void) | null = null;
			const stop = (reachedEnd: boolean) => {
				if (stopped) return;
				stopped = true;
				unsubscribe?.();
				previewStop = null;
				editor.playback.pause();
				clearRepairPreview();
				if (reachedEnd) {
					post({ type: "PREVIEW_STATE", identity: message, payload: { mode: "stop", playing: false, reachedEnd: true } });
				}
			};
			unsubscribe = editor.playback.subscribe(() => {
				if (stopped) return;
				const playing = editor.playback.getIsPlaying();
				if (playing) sawPlaying = true;
				const currentSeconds = mediaTimeToSeconds({ time: editor.playback.getCurrentTime() });
				if (currentSeconds >= preview.endSeconds || (sawPlaying && !playing)) stop(true);
			});
			previewStop = () => stop(false);
			post({ type: "PREVIEW_STATE", identity: message, payload: { mode: preview.mode, playing: true } });
		};

		const setMarkers = async (message: VideoFinisherHostMessage) => {
			const markers = normalizedMarkers(message.payload);
			if (!markers) throw new Error("Studio returned an invalid marker set.");
			const scene = editor.scenes.getActiveScene();
			applyingRef.current = true;
			try {
				editor.scenes.setScenes({
					scenes: updateSceneInArray({
						scenes: editor.scenes.getScenes(),
						sceneId: scene.id,
						updates: { bookmarks: kartelMarkerBookmarks({ markers, existing: scene.bookmarks }) },
					}),
				});
			} finally {
				applyingRef.current = false;
			}
			post({ type: "MARKERS_SET", identity: message, payload: { count: markers.length } });
		};

		// Breakdown: split the source clip at each detected cut, name each piece after its shot, and
		// seat any ready audio layer on its own track. Idempotent: a cut that already exists is not
		// split again and a stem already present is reported as replayed.
		const applyBreakdown = async (message: VideoFinisherHostMessage) => {
			const breakdown = normalizedBreakdown(message.payload);
			if (!breakdown) throw new Error("Studio returned an invalid breakdown request.");
			const sourceMediaId = sourceMediaIdRef.current;
			const isSourceElement = (element: TimelineElement) =>
				sourceMediaId !== null && element.type === "video" && element.mediaId === sourceMediaId;
			const mainTrack = () => editor.scenes.getActiveScene().tracks.main;
			if (!mainTrack().elements.some(isSourceElement)) {
				throw new Error("The source clip is not present in this project revision.");
			}
			// Decode both exact versions before changing the timeline. A partial pair
			// must never replace the mix or leave an extra audible dialogue layer.
			if (breakdown.stems.length === 1) throw new Error("Both dialogue and background layers must be ready before applying separated audio.");
			const decodedStems = new Map<string, Awaited<ReturnType<typeof processMediaAssets>>[number]>();
			for (const stem of breakdown.stems) {
				const file = await repairCandidateFile({ candidate: stem.candidate });
				const [processed] = await processMediaAssets({ files: [file] });
				if (!processed || processed.type !== "audio" || !Number.isFinite(processed.duration)) throw new Error(`OpenCut could not decode the ${stem.label.toLowerCase()} layer.`);
				for (const piece of mainTrack().elements.filter(isSourceElement)) breakdownStemGeometry({ piece, stemDurationSeconds: processed.duration ?? 0 });
				decodedStems.set(stemMediaId(stem), processed);
			}
			const startOf = (element: TimelineElement) => mediaTimeToSeconds({ time: element.startTime });
			applyingRef.current = true;
			let splitCount = 0;
			try {
				for (const cut of breakdown.cuts) {
					const track = mainTrack();
					for (const target of track.elements.filter(isSourceElement)) {
						const seconds = breakdownCutTimelineSeconds({ element: target, sourceSeconds: cut });
						if (seconds === null) continue;
						editor.timeline.splitElements({
							elements: [{ trackId: track.id, elementId: target.id }],
							splitTime: mediaTimeFromSeconds({ seconds }),
						});
						splitCount += 1;
					}
				}
				const track = mainTrack();
				const pieces = track.elements.filter(isSourceElement).sort((a, b) => startOf(a) - startOf(b));
				// Every source piece takes the name of the shot it starts inside, so a merged shot that
				// still spans two timeline pieces reads as one shot in both places.
				const shotOf = (piece: TimelineElement) =>
					breakdown.shots.find((shot) => breakdownSourceRange(piece).startSeconds >= shot.startSeconds - 0.011 && breakdownSourceRange(piece).startSeconds < shot.endSeconds - 0.011) ?? null;
				const shots = breakdown.shots.map((shot) => ({
					...shot,
					elementIds: pieces.filter((piece) => shotOf(piece)?.id === shot.id).map((piece) => piece.id),
					trackId: track.id,
				}));
				// A single-shot video keeps its own clip name; shot labels only help once there are several.
				const renames = breakdown.shots.length < 2 ? [] : pieces.flatMap((piece) => {
					const shot = shotOf(piece);
					if (!shot || piece.name === shot.label) return [];
					return [{ trackId: track.id, elementId: piece.id, patch: { name: shot.label } as Partial<TimelineElement> }];
				});
				if (renames.length) editor.timeline.updateElements({ updates: renames });

				const stems: { role: string; elementId: string; trackId: string; replayed: boolean }[] = [];
				for (const stem of breakdown.stems) {
					const mediaId = stemMediaId(stem);
					const processed = decodedStems.get(mediaId);
					if (!processed) throw new Error("The decoded audio pair is incomplete.");
					const created = editor.media.getAssets().find((asset) => asset.id === mediaId)
						?? await editor.media.addMediaAsset({ projectId, asset: { ...processed, id: mediaId } });
					if (!created || created.type !== "audio") throw new Error(`The ${stem.label.toLowerCase()} layer is not an audio file.`);
					for (const piece of pieces) {
						const existing = findBreakdownStemElement({ tracks: editor.scenes.getActiveScene().tracks.audio, mediaId, piece });
						if (existing) {
							if (existing.mutedTrack) throw new Error("A separated audio track is muted. Review it before applying the pair.");
							stems.push({ role: stem.role, elementId: existing.id, trackId: existing.trackId, replayed: true });
							continue;
						}
						const element = buildElementFromMedia({ mediaId, mediaType: "audio", name: stem.label, duration: piece.duration, startTime: piece.startTime });
						if (element.type !== "audio") throw new Error("The separated layer is not audio.");
						editor.timeline.insertElement({
							element: { ...element, ...breakdownStemGeometry({ piece, stemDurationSeconds: created.duration ?? 0 }), params: { ...element.params, muted: true } },
							placement: { mode: "auto", trackType: "audio" },
						});
						const inserted = findBreakdownStemElement({ tracks: editor.scenes.getActiveScene().tracks.audio, mediaId, piece });
						if (!inserted || inserted.mutedTrack) throw new Error(`OpenCut could not confirm the ${stem.label.toLowerCase()} layer. New pieces remain muted.`);
						stems.push({ role: stem.role, elementId: inserted.id, trackId: inserted.trackId, replayed: false });
					}
				}
				// Switch the complete pair in one timeline command. Superseded exact-version
				// layers stay recoverable but silent; unrelated operator audio is untouched.
				if (stems.length === pieces.length * 2) {
					const active = new Set(stems.map((stem) => stem.elementId));
					const scene = editor.scenes.getActiveScene();
					const updates = [scene.tracks.main, ...scene.tracks.audio].flatMap((audioTrack) => audioTrack.elements.flatMap((element) => {
						if (!canElementHaveAudio(element)) return [];
						if (!isSourceElement(element) && !("mediaId" in element && element.mediaId.startsWith("kartel-stem-"))) return [];
						const muted = !active.has(element.id);
						if (element.params.muted === muted) return [];
						return [{ trackId: audioTrack.id, elementId: element.id, patch: { params: { ...element.params, muted } } as Partial<TimelineElement> }];
					}));
					if (updates.length) editor.timeline.updateElements({ updates });
				}
				await editor.save.flush();
				identityRef.current = message;
				post({
					type: "BREAKDOWN_APPLIED",
					identity: message,
					payload: {
						shots,
						stems,
						splitCount,
						pieceCount: pieces.length,
						sourceLayout: sourceLayout(),
						replayed: splitCount === 0 && stems.every((stem) => stem.replayed),
					},
				});
			} finally {
				applyingRef.current = false;
			}
		};

		// Selection from the finishing rail: pick one clip (by id, or the main-track piece that starts
		// at a time), park the playhead on it, and let the ordinary selection event follow.
		const selectRange = async (message: VideoFinisherHostMessage) => {
			const request = normalizedRangeSelection(message.payload);
			if (!request) throw new Error("Studio returned an invalid selection request.");
			const scene = editor.scenes.getActiveScene();
			const tracks = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
			let found: { track: TimelineTrack; element: TimelineElement } | null = null;
			for (const track of tracks) {
				for (const element of track.elements) {
					const startSeconds = mediaTimeToSeconds({ time: element.startTime });
					const sourceRange = breakdownSourceRange(element);
					if (
						(request.clipId !== null && element.id === request.clipId) ||
						(request.clipId === null && track.id === scene.tracks.main.id && request.startSeconds !== null && Math.abs(startSeconds - request.startSeconds) < 0.011) ||
						(request.clipId === null && request.sourceSeconds !== null && element.type === "video" && element.mediaId === sourceMediaIdRef.current && request.sourceSeconds >= sourceRange.startSeconds - 0.011 && request.sourceSeconds < sourceRange.endSeconds - 0.011)
					) {
						found = { track, element };
						break;
					}
				}
				if (found) break;
			}
			if (!found) throw new Error("No clip starts at that point in this project revision.");
			editor.selection.setSelectedElements({ elements: [{ trackId: found.track.id, elementId: found.element.id }] });
			editor.playback.pause();
			editor.playback.seek({ time: found.element.startTime });
			identityRef.current = message;
			post({
				type: "RANGE_SELECTED",
				identity: message,
				payload: selectionCoordinates({ element: found.element, sourceMediaId: sourceMediaIdRef.current }),
			});
		};

		const exportProject = async (message: VideoFinisherHostMessage) => {
			post({
				type: "EXPORT_STARTED",
				identity: message,
				payload: { progress: 0 },
			});
			let lastProgress = -1;
			const unsubscribe = editor.project.subscribe(() => {
				const state = editor.project.getExportState();
				const rounded = Math.max(
					0,
					Math.min(100, Math.round(state.progress * 100)),
				);
				if (state.isExporting && rounded !== lastProgress) {
					lastProgress = rounded;
					post({
						type: "EXPORT_PROGRESS",
						identity: message,
						payload: { progress: rounded / 100 },
					});
				}
			});
			try {
				const active = editor.project.getActive();
				const result = await editor.project.export({
					options: {
						format: "mp4",
						quality: "high",
						fps: active.settings.fps,
						includeAudio: true,
						requireAudioTrack: true,
					},
				});
				if (!result.success || !result.buffer)
					throw new Error(result.error || "OpenCut export failed.");
				if (result.videoCodec !== "h264" || result.audioCodec !== "aac") {
					throw new Error(
						"This browser could not produce the required H.264/AAC MP4. The project remains saved.",
					);
				}
				const file = new File(
					[result.buffer],
					`${safeSourceName(active.metadata.name).replace(/\.(mov|webm)$/i, ".mp4")}`,
					{ type: "video/mp4", lastModified: Date.now() },
				);
				const metadata = {
					container: "mp4" as const,
					videoCodec: result.videoCodec,
					audioCodec: result.audioCodec,
					durationSeconds: mediaTimeToSeconds({
						time: editor.timeline.getTotalDuration(),
					}),
					frameRate: videoFinisherExportFrameRate(active.settings.fps),
					width: active.settings.canvasSize.width,
					height: active.settings.canvasSize.height,
				};
				await cacheVideoFinisherExport({
					projectId,
					operationId: message.operationId,
					file,
					metadata,
				});
				post({
					type: "EXPORT_COMPLETED",
					identity: message,
					payload: { file, filename: file.name, metadata, replayed: false },
				});
			} finally {
				unsubscribe();
				editor.project.clearExportState();
			}
		};

		const observeExport = async (message: VideoFinisherHostMessage) => {
			const cached = await readCachedVideoFinisherExport({
				projectId,
				operationId: message.operationId,
			});
			if (!cached) {
				post({
					type: "EXPORT_NOT_FOUND",
					identity: message,
					payload: { present: false },
				});
				return;
			}
			post({
				type: "EXPORT_COMPLETED",
				identity: message,
				payload: {
					file: cached.file,
					filename: cached.file.name,
					metadata: cached.metadata,
					replayed: true,
				},
			});
		};

		const releaseExport = async (message: VideoFinisherHostMessage) => {
			const released = await releaseCachedVideoFinisherExport({
				projectId,
				operationId: message.operationId,
			});
			post({
				type: "EXPORT_RELEASED",
				identity: message,
				payload: { released },
			});
		};
		const onMessage = (event: MessageEvent) => {
			if (event.source !== window.parent || event.origin !== hostOrigin) return;
			if (!isHostMessage(event.data)) return;
			const message = event.data;
			if (
				message.projectId !== projectId ||
				message.nonce !== bridgeNonce ||
				message.operationId.length < 1 ||
				message.operationId.length > 240 ||
				message.revision < 0
			)
				return;
			const action =
				message.type === "LOAD_PROJECT"
					? loadQueueRef.current(() => load(message))
					: message.type === "SAVE_PROJECT"
						? save(message)
						: message.type === "INSERT_REPLACEMENT"
							? insertReplacement(message)
							: message.type === "OBSERVE_REPLACEMENT"
								? observeReplacement(message)
								: message.type === "OBSERVE_EXPORT"
									? observeExport(message)
									: message.type === "RELEASE_EXPORT"
										? releaseExport(message)
										: message.type === "PREVIEW_RANGE"
											? previewRange(message)
											: message.type === "SET_MARKERS"
												? setMarkers(message)
												: message.type === "APPLY_BREAKDOWN"
													? applyBreakdown(message)
													: message.type === "SELECT_RANGE"
														? selectRange(message)
										: exportProject(message);
			void action.catch((error) =>
				post({
					type:
						message.type === "LOAD_PROJECT"
							? "LOAD_FAILED"
							: message.type === "SAVE_PROJECT"
								? "SAVE_FAILED"
								: message.type === "INSERT_REPLACEMENT" || message.type === "OBSERVE_REPLACEMENT"
									? "REPAIR_FAILED"
									: message.type === "PREVIEW_RANGE"
										? "PREVIEW_FAILED"
										: message.type === "SET_MARKERS"
											? "MARKERS_FAILED"
											: message.type === "APPLY_BREAKDOWN"
												? "BREAKDOWN_FAILED"
												: message.type === "SELECT_RANGE"
													? "SELECT_FAILED"
											: "EXPORT_FAILED",
					identity: message,
					payload: {
						error:
							error instanceof Error
								? error.message
								: "OpenCut bridge operation failed.",
					},
				}),
			);
		};

		const sourceLayout = () => {
			const tracks = editor.scenes.getActiveScene().tracks;
			return videoFinisherSourceLayout({ tracks: [...tracks.overlay, tracks.main, ...tracks.audio], sourceMediaId: sourceMediaIdRef.current });
		};
		const changed = () => {
			if (applyingRef.current || !identityRef.current) return;
			post({ type: "PROJECT_CHANGED", identity: identityRef.current, payload: { sourceLayout: sourceLayout() } });
			selected();
			lastPlayheadSeconds = -1;
			playhead();
		};
		const selected = () => {
			if (applyingRef.current || !identityRef.current) return;
			const [selection] = editor.timeline.getElementsWithTracks({
				elements: editor.selection.getSelectedElements(),
			});
			post({
				type: "SELECTION_CHANGED",
				identity: identityRef.current,
				payload: selection ? selectionCoordinates({ element: selection.element, sourceMediaId: sourceMediaIdRef.current }) : null,
			});
		};
		// The playhead streams to Studio (throttled) so the finishing rail can mark in and out
		// points from where the operator is parked, without OpenCut growing an in/out model.
		let lastPlayheadPost = 0;
		let lastPlayheadSeconds = -1;
		const playhead = () => {
			if (!identityRef.current) return;
			const seconds = mediaTimeToSeconds({ time: editor.playback.getCurrentTime() });
			const playing = editor.playback.getIsPlaying();
			const now = Date.now();
			if (playing && now - lastPlayheadPost < 200) return;
			if (!playing && seconds === lastPlayheadSeconds) return;
			lastPlayheadPost = now;
			lastPlayheadSeconds = seconds;
			const sourcePositions = editor.scenes.getActiveScene().tracks.main.elements
				.filter((element) => element.type === "video" && element.mediaId === sourceMediaIdRef.current)
				.map((element) => breakdownSourceAtTimeline({ element, timelineSeconds: seconds }))
				.filter((position) => position !== null);
			post({ type: "PLAYHEAD_CHANGED", identity: identityRef.current, payload: { seconds, playing, sourceSeconds: sourcePositions.length === 1 ? sourcePositions[0] : null } });
		};
		window.addEventListener("message", onMessage);
		post({
			type: "EDITOR_READY",
			identity: { nonce: bridgeNonce, projectId, revision: 0, operationId: "editor-ready" },
		});
		const unsubscribers = [
			editor.timeline.subscribe(changed),
			editor.scenes.subscribe(changed),
			editor.selection.subscribe(selected),
			editor.playback.subscribe(playhead),
		];
		return () => {
			window.removeEventListener("message", onMessage);
			previewStop?.();
			clearRepairPreview();
			unsubscribers.forEach((unsubscribe) => unsubscribe());
		};
	}, [editor, hostOrigin, projectId]);

	return null;
}
