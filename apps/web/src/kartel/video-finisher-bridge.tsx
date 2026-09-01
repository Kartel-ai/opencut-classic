"use client";

import { useEffect, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { storageService } from "@/services/storage/service";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { toElementDurationTicks } from "@/timeline/creation";
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
} from "./video-finisher-protocol";
import type { VideoFinisherHostMessage } from "./video-finisher-protocol";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const OPEN_CUT_COMMIT = /^[0-9a-f]{40}$/.test(
	process.env.NEXT_PUBLIC_KARTEL_OPEN_CUT_COMMIT ?? "",
)
	? (process.env.NEXT_PUBLIC_KARTEL_OPEN_CUT_COMMIT ?? "")
	: "";

type HostProject = {
	source?: {
		assetId?: string;
		versionId?: string;
		name?: string;
		src?: string;
		byteSize?: number;
		sha256?: string;
	};
	document?: unknown;
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
	tracks: readonly { elements: readonly unknown[] }[];
	mediaId: string;
}): { id: string; mediaId: string } | null {
	for (const track of tracks) {
		for (const element of track.elements) {
			if (isRecord(element) && typeof element.id === "string" && element.mediaId === mediaId) {
				return { id: element.id, mediaId };
			}
		}
	}
	return null;
}

export function normalizedRepairInsertion(value: unknown): RepairInsertion | null {
	if (!isRecord(value) || !isRecord(value.candidate)) return null;
	const candidate = value.candidate;
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
	const mimeType = String(candidate.mimeType ?? "").toLowerCase();
	const startSeconds = Number(value.startSeconds);
	const endSeconds = Number(value.endSeconds);
	const durationSeconds = Number(candidate.durationSeconds);
	const byteSize = Number(candidate.byteSize);
	const expectedMIME = semanticRole === "replacement_voice"
		? "audio/wav"
		: semanticRole === "keyframe"
			? ["image/png", "image/jpeg", "image/webp"]
			: "video/mp4";
	if (
		typeof value.clipId !== "string" || value.clipId.length < 1 || value.clipId.length > 160 ||
		!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > 6 * 60 * 60 ||
		!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 6 * 60 * 60 ||
		!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_SOURCE_BYTES ||
		typeof candidate.assetId !== "string" || candidate.assetId.length < 1 || candidate.assetId.length > 160 ||
		typeof candidate.versionId !== "string" || candidate.versionId.length < 1 || candidate.versionId.length > 160 ||
		typeof candidate.name !== "string" || candidate.name.trim().length < 1 || candidate.name.length > 255 ||
		typeof candidate.src !== "string" ||
		typeof candidate.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(candidate.sha256) ||
		(Array.isArray(expectedMIME) ? !expectedMIME.includes(mimeType) : mimeType !== expectedMIME)
	) return null;
	if (semanticRole !== "keyframe" && durationSeconds + 0.05 < endSeconds - startSeconds) return null;
	return {
		semanticRole,
		clipId: value.clipId,
		startSeconds,
		endSeconds,
		candidate: {
			assetId: candidate.assetId,
			versionId: candidate.versionId,
			name: candidate.name.trim(),
			src: candidate.src,
			mimeType,
			byteSize,
			sha256: candidate.sha256,
			durationSeconds,
		},
	};
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

function isHostMessage(value: unknown): value is VideoFinisherHostMessage {
	if (!isRecord(value)) return false;
	const message = value;
	return (
		message.bridge === VIDEO_FINISHER_BRIDGE &&
		message.version === VIDEO_FINISHER_BRIDGE_VERSION &&
		["LOAD_PROJECT", "SAVE_PROJECT", "INSERT_REPLACEMENT", "OBSERVE_REPLACEMENT", "EXPORT_PROJECT"].includes(
			String(message.type),
		) &&
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
		: mimeType === "image/png" ? ".png"
			: mimeType === "image/jpeg" ? ".jpg"
				: mimeType === "image/webp" ? ".webp" : ".mp4";
	return value.toLowerCase().endsWith(extension) ? value : `${value || "repair-candidate"}${extension}`;
}

async function repairCandidateFile(insertion: RepairInsertion): Promise<File> {
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

async function sourceFile(project: HostProject): Promise<File> {
	const source = project.source;
	if (!source?.src || !source.versionId)
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
			const file = await sourceFile(project);
			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed)
				throw new Error("OpenCut could not decode the source version.");
			const created = await editor.media.addMediaAsset({
				projectId,
				asset: { ...processed, id: versionId },
			});
			if (!created)
				throw new Error("OpenCut could not retain the source version.");
			return created;
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
				if (!hasTimelineSource) {
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
					document: stored.project,
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
				post({
					type: "EXPORT_COMPLETED",
					identity: message,
					payload: {
						file,
						filename: file.name,
						metadata: {
							container: "mp4",
							videoCodec: result.videoCodec,
							audioCodec: result.audioCodec,
							durationSeconds: mediaTimeToSeconds({
								time: editor.timeline.getTotalDuration(),
							}),
							frameRate: active.settings.fps,
							width: active.settings.canvasSize.width,
							height: active.settings.canvasSize.height,
						},
					},
				});
			} finally {
				unsubscribe();
				editor.project.clearExportState();
			}
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
					? load(message)
					: message.type === "SAVE_PROJECT"
						? save(message)
						: message.type === "INSERT_REPLACEMENT"
							? insertReplacement(message)
							: message.type === "OBSERVE_REPLACEMENT"
								? observeReplacement(message)
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

		const changed = () => {
			if (applyingRef.current || !identityRef.current) return;
			post({ type: "PROJECT_CHANGED", identity: identityRef.current });
		};
		const selected = () => {
			if (applyingRef.current || !identityRef.current) return;
			const [selection] = editor.timeline.getElementsWithTracks({
				elements: editor.selection.getSelectedElements(),
			});
			if (!selection) return;
			post({
				type: "SELECTION_CHANGED",
				identity: identityRef.current,
				payload: {
					clipId: selection.element.id,
					startSeconds: mediaTimeToSeconds({
						time: selection.element.startTime,
					}),
					endSeconds: mediaTimeToSeconds({
						time: addMediaTime({
							a: selection.element.startTime,
							b: selection.element.duration,
						}),
					}),
				},
			});
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
		];
		return () => {
			window.removeEventListener("message", onMessage);
			unsubscribers.forEach((unsubscribe) => unsubscribe());
		};
	}, [editor, hostOrigin, projectId]);

	return null;
}
