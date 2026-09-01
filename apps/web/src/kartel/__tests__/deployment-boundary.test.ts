import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { GET as getHealth } from "../../app/healthz/route";
import { proxy } from "../../proxy";
import { isKartelEmbedOnly, isKartelServicePath } from "../deployment-boundary";

const originalEmbedOnly = process.env.KARTEL_EMBED_ONLY;
const originalCommit = process.env.RAILWAY_GIT_COMMIT_SHA;

afterEach(() => {
	if (originalEmbedOnly === undefined) delete process.env.KARTEL_EMBED_ONLY;
	else process.env.KARTEL_EMBED_ONLY = originalEmbedOnly;
	if (originalCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
	else process.env.RAILWAY_GIT_COMMIT_SHA = originalCommit;
});

describe("Kartel deployment boundary", () => {
	test("admits only health and one exact editor project in embed-only mode", () => {
		expect(isKartelServicePath("/healthz")).toBe(true);
		expect(isKartelServicePath("/kartel/editor/project-1")).toBe(true);
		expect(isKartelServicePath("/kartel/editor/project-1/")).toBe(true);
		expect(isKartelServicePath("/")).toBe(false);
		expect(isKartelServicePath("/editor/project-1")).toBe(false);
		expect(isKartelServicePath("/kartel/editor/project-1/extra")).toBe(false);
		expect(isKartelServicePath("/api/sounds/search")).toBe(false);
	});

	test("leaves the upstream application unchanged unless explicitly enabled", () => {
		expect(isKartelEmbedOnly({ KARTEL_EMBED_ONLY: undefined })).toBe(false);
		expect(isKartelEmbedOnly({ KARTEL_EMBED_ONLY: "false" })).toBe(false);
		expect(isKartelEmbedOnly({ KARTEL_EMBED_ONLY: "true" })).toBe(true);
	});

	test("returns a fail-closed 404 before unsupported routes render", () => {
		process.env.KARTEL_EMBED_ONLY = "true";
		const denied = proxy(
			new NextRequest("https://editor.example/api/sounds/search"),
		);
		const admitted = proxy(
			new NextRequest("https://editor.example/kartel/editor/project-1"),
		);
		expect(denied.status).toBe(404);
		expect(denied.headers.get("cache-control")).toBe("no-store");
		expect(admitted.status).toBe(200);
		expect(admitted.headers.get("x-middleware-next")).toBe("1");
	});

	test("reports the exact served Railway commit without loading auth configuration", async () => {
		process.env.RAILWAY_GIT_COMMIT_SHA = "commit-123";
		const response = getHealth();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			ok: true,
			service: "kartel-video-finisher-editor",
			commit: "commit-123",
		});
	});
});
