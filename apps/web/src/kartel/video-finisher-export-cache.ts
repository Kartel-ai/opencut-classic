const CACHE_NAME = "kartel-video-finisher-export-v1";
const CACHE_PATH = "/__kartel_video_finisher_exports__/";
export const VIDEO_FINISHER_EXPORT_MAX_BYTES = 100 * 1024 * 1024;

export type VideoFinisherExportMetadata = {
	container: "mp4";
	videoCodec: "h264";
	audioCodec: "aac";
	durationSeconds: number;
	frameRate: number;
	width: number;
	height: number;
};

export type CachedVideoFinisherExport = {
	file: File;
	metadata: VideoFinisherExportMetadata;
};

export type VideoFinisherExportCache = {
	put(input: { request: Request; response: Response }): Promise<void>;
	match(request: Request): Promise<Response | undefined>;
	delete(request: Request): Promise<boolean>;
};

export type VideoFinisherExportCacheStorage = {
	open(name: string): Promise<VideoFinisherExportCache>;
};

function validIdentity(value: string): boolean {
	return value.length >= 1 && value.length <= 240;
}

function finitePositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizedMetadata(
	value: Partial<Record<keyof VideoFinisherExportMetadata, unknown>>,
): VideoFinisherExportMetadata | null {
	if (
		value?.container !== "mp4" ||
		value.videoCodec !== "h264" ||
		value.audioCodec !== "aac" ||
		!finitePositive(value.durationSeconds) ||
		!finitePositive(value.frameRate) ||
		!safePositiveInteger(value.width) ||
		!safePositiveInteger(value.height)
	) return null;
	return {
		container: "mp4",
		videoCodec: "h264",
		audioCodec: "aac",
		durationSeconds: value.durationSeconds,
		frameRate: value.frameRate,
		width: value.width,
		height: value.height,
	};
}

export function videoFinisherExportCacheKey({
	projectId,
	operationId,
	origin = globalThis.location?.origin ?? "https://kartel-video-finisher.invalid",
}: { projectId: string; operationId: string; origin?: string }): Request {
	if (!validIdentity(projectId) || !validIdentity(operationId)) {
		throw new Error("The exact export cache identity is invalid.");
	}
	const url = new URL(
		`${CACHE_PATH}${encodeURIComponent(projectId)}/${encodeURIComponent(operationId)}`,
		origin,
	);
	return new Request(url, { method: "GET", credentials: "omit" });
}

function browserCacheStorage(): VideoFinisherExportCacheStorage | undefined {
	if (!globalThis.caches) return undefined;
	return {
		async open(name) {
			const cache = await globalThis.caches.open(name);
			return {
				put: ({ request, response }) => cache.put(request, response),
				match: (request) => cache.match(request),
				delete: (request) => cache.delete(request),
			};
		},
	};
}

export async function cacheVideoFinisherExport({
	projectId,
	operationId,
	file,
	metadata,
	cacheStorage = browserCacheStorage(),
	origin,
}: {
	projectId: string;
	operationId: string;
	file: File;
	metadata: VideoFinisherExportMetadata;
	cacheStorage?: VideoFinisherExportCacheStorage;
	origin?: string;
}): Promise<void> {
	const normalized = normalizedMetadata(metadata);
	if (
		!cacheStorage ||
		!(file instanceof File) ||
		file.type !== "video/mp4" ||
		file.size < 1 ||
		file.size > VIDEO_FINISHER_EXPORT_MAX_BYTES ||
		!normalized
	) throw new Error("OpenCut could not checkpoint the exact exported MP4.");
	const request = videoFinisherExportCacheKey({ projectId, operationId, origin });
	const cache = await cacheStorage.open(CACHE_NAME);
	await cache.put({
		request,
		response: new Response(file, {
			headers: {
				"content-type": "video/mp4",
				"content-length": String(file.size),
				"x-kartel-filename": encodeURIComponent(file.name.slice(0, 240)),
				"x-kartel-container": normalized.container,
				"x-kartel-video-codec": normalized.videoCodec,
				"x-kartel-audio-codec": normalized.audioCodec,
				"x-kartel-duration-seconds": String(normalized.durationSeconds),
				"x-kartel-frame-rate": String(normalized.frameRate),
				"x-kartel-width": String(normalized.width),
				"x-kartel-height": String(normalized.height),
			},
		}),
	});
}

export async function readCachedVideoFinisherExport({
	projectId,
	operationId,
	cacheStorage = browserCacheStorage(),
	origin,
}: {
	projectId: string;
	operationId: string;
	cacheStorage?: VideoFinisherExportCacheStorage;
	origin?: string;
}): Promise<CachedVideoFinisherExport | null> {
	if (!cacheStorage) return null;
	const request = videoFinisherExportCacheKey({ projectId, operationId, origin });
	const cache = await cacheStorage.open(CACHE_NAME);
	const response = await cache.match(request);
	if (!response) return null;
	let filename = "finished.mp4";
	try { filename = decodeURIComponent(response.headers.get("x-kartel-filename") ?? filename); } catch { /* invalid header is rejected below */ }
	const metadata = normalizedMetadata({
		container: response.headers.get("x-kartel-container"),
		videoCodec: response.headers.get("x-kartel-video-codec"),
		audioCodec: response.headers.get("x-kartel-audio-codec"),
		durationSeconds: Number(response.headers.get("x-kartel-duration-seconds")),
		frameRate: Number(response.headers.get("x-kartel-frame-rate")),
		width: Number(response.headers.get("x-kartel-width")),
		height: Number(response.headers.get("x-kartel-height")),
	});
	const expectedSize = Number(response.headers.get("content-length"));
	const blob = await response.blob();
	if (
		response.headers.get("content-type") !== "video/mp4" ||
		!filename ||
		filename.length > 240 ||
		!Number.isSafeInteger(expectedSize) ||
		expectedSize < 1 ||
		expectedSize > VIDEO_FINISHER_EXPORT_MAX_BYTES ||
		blob.size !== expectedSize ||
		blob.type !== "video/mp4" ||
		!metadata
	) {
		await cache.delete(request);
		return null;
	}
	return {
		file: new File([blob], filename, { type: "video/mp4", lastModified: 0 }),
		metadata,
	};
}

export async function releaseCachedVideoFinisherExport({
	projectId,
	operationId,
	cacheStorage = browserCacheStorage(),
	origin,
}: {
	projectId: string;
	operationId: string;
	cacheStorage?: VideoFinisherExportCacheStorage;
	origin?: string;
}): Promise<boolean> {
	if (!cacheStorage) return false;
	const request = videoFinisherExportCacheKey({ projectId, operationId, origin });
	const cache = await cacheStorage.open(CACHE_NAME);
	return cache.delete(request);
}
