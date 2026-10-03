import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Bun 1.2.18 cannot optimize the WASM package's wildcard sideEffects declaration.
// Keep that exact packaging warning distinct from every runtime diagnostic.
function unexpectedFixtureDiagnostics(stderr: string): string {
	return stderr.replace(/\d+ \|\s+"\.\/snippets\/\*"\r?\n\s+\^\r?\nwarn: wildcard sideEffects are not supported yet, which means this package will be deoptimized\r?\n\s+at [^\r\n]*[\\/]node_modules[\\/]opencut-wasm[\\/]package\.json:\d+:\d+\r?\n?/g, "").trim();
}

test("fixture diagnostics allow only the known Bun WASM packaging warning", () => {
	const warning = '21 |     "./snippets/*"\n         ^\nwarn: wildcard sideEffects are not supported yet, which means this package will be deoptimized\n   at C:\\candidate\\node_modules\\opencut-wasm\\package.json:21:5\n';
	expect(unexpectedFixtureDiagnostics(warning)).toBe("");
	expect(unexpectedFixtureDiagnostics(warning + "error: export failed")).toBe("error: export failed");
	expect(unexpectedFixtureDiagnostics(warning.replace("opencut-wasm", "another-package"))).not.toBe("");
	expect(unexpectedFixtureDiagnostics("warn: unexpected output")).not.toBe("");
});


test("export stops encoding on packet overflow, guards final container bytes and consumes the canvas under its lock", async () => {
	const result = Bun.spawn({
		cmd: [
			process.execPath,
			"--preload",
			fileURLToPath(new URL("../../../../../test/setup.ts", import.meta.url)),
			fileURLToPath(new URL("./scene-exporter.fixture.ts", import.meta.url)),
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(result.stdout).text(),
		new Response(result.stderr).text(),
		result.exited,
	]);
	expect({ exitCode, stderr: unexpectedFixtureDiagnostics(stderr) }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(stdout)).toEqual({
		framesBeforeCap: 4,
		totalFrames: 240,
		terminalCancels: 2,
		canvasConsumptionSerialized: true,
		nativeExport: { width: 1280, height: 720 },
	});
});

test("preview decoders retain resolution, invalidate replaced Files and cannot reopen after disposal", async () => {
	const result = Bun.spawn({
		cmd: [
			process.execPath,
			fileURLToPath(new URL("./video-cache.fixture.ts", import.meta.url)),
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(result.stdout).text(),
		new Response(result.stderr).text(),
		result.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(stdout)).toEqual({
		reusedDecoder: true,
		reducedSize: [960, 540],
		replacementInvalidatedBothSizes: true,
		pendingDecoderDisposed: true,
		thumbnailPipelines: 1,
		thumbnailSamplesClosed: 24,
		thumbnailCanvases: 1,
	});
});
