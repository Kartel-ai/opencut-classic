import { describe, expect, test } from "bun:test";
import {
	cacheVideoFinisherExport,
	readCachedVideoFinisherExport,
	releaseCachedVideoFinisherExport,
	videoFinisherExportCacheKey,
} from "../video-finisher-export-cache";

class MemoryCache {
	items = new Map<string, Response>();
	async put({ request, response }: { request: Request; response: Response }) {
		this.items.set(request.url, response.clone());
	}
	async match(request: Request) { return this.items.get(request.url)?.clone(); }
	async delete(request: Request) { return this.items.delete(request.url); }
}

class MemoryCacheStorage {
	cache = new MemoryCache();
	async open() { return this.cache; }
}

const metadata = {
	container: "mp4" as const,
	videoCodec: "h264" as const,
	audioCodec: "aac" as const,
	durationSeconds: 6.04,
	frameRate: 24_000 / 1_001,
	width: 1920,
	height: 1080,
};

describe("Video Finisher export cache", () => {
	test("restores the exact completed MP4 by operation identity without rendering", async () => {
		const cacheStorage = new MemoryCacheStorage();
		const file = new File([new Uint8Array([0, 1, 2, 3])], "finished.mp4", { type: "video/mp4" });
		await cacheVideoFinisherExport({
			projectId: "project-1", operationId: "export-operation-1", file, metadata, cacheStorage,
			origin: "https://editor.example",
		});

		const restored = await readCachedVideoFinisherExport({
			projectId: "project-1", operationId: "export-operation-1", cacheStorage,
			origin: "https://editor.example",
		});
		expect(restored?.file.name).toBe("finished.mp4");
		expect(restored?.file.type).toBe("video/mp4");
		expect(new Uint8Array(await restored!.file.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
		expect(restored?.metadata).toEqual(metadata);
		expect(await releaseCachedVideoFinisherExport({
			projectId: "project-1", operationId: "export-operation-1", cacheStorage,
			origin: "https://editor.example",
		})).toBe(true);
		expect(await readCachedVideoFinisherExport({
			projectId: "project-1", operationId: "export-operation-1", cacheStorage,
			origin: "https://editor.example",
		})).toBeNull();
	});

	test("returns absence for a different operation and evicts malformed receipts", async () => {
		const cacheStorage = new MemoryCacheStorage();
		expect(await readCachedVideoFinisherExport({
			projectId: "project-1", operationId: "export-absent", cacheStorage,
			origin: "https://editor.example",
		})).toBeNull();

		const request = videoFinisherExportCacheKey({
			projectId: "project-1", operationId: "export-malformed", origin: "https://editor.example",
		});
		await cacheStorage.cache.put({
			request,
			response: new Response(new Uint8Array([1]), {
				headers: { "content-type": "video/mp4", "content-length": "1" },
			}),
		});
		expect(await readCachedVideoFinisherExport({
			projectId: "project-1", operationId: "export-malformed", cacheStorage,
			origin: "https://editor.example",
		})).toBeNull();
		expect(cacheStorage.cache.items.has(request.url)).toBe(false);
	});
});
