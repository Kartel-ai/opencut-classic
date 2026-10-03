import { describe, expect, test } from "bun:test";
import { createExportAudioDecodeCache } from "../export-audio-cache";
import { collectAudioElements } from "../audio";
import { buildDefaultScene } from "@/timeline/scenes";
import type { MediaAsset } from "@/media/types";
import type { UploadAudioElement } from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

describe("export source audio reuse", () => {
	test("24 source cuts decode once and keep independent trim/gain coordinates", async () => {
		let decodes = 0;
		// Collection only retains decoded buffer identity; mixing is tested separately.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const buffer = { sampleRate: 44100 } as AudioBuffer;
		// This browser double implements the only AudioContext method collection uses.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const audioContext = {
			decodeAudioData: async () => {
				decodes++;
				return buffer;
			},
		} as unknown as AudioContext;
		const file = new File([new Uint8Array(20)], "source.wav", {
			type: "audio/wav",
		});
		const asset = {
			id: "source",
			name: file.name,
			type: "audio",
			file,
			url: "blob:source",
		} as MediaAsset;
		const tracks = buildDefaultScene({ name: "Main", isMain: true }).tracks;
		const elements: UploadAudioElement[] = Array.from(
			{ length: 24 },
			(_, index) => ({
				id: `cut-${index}`,
				name: "cut",
				type: "audio",
				sourceType: "upload",
				mediaId: asset.id,
				startTime: mediaTimeFromSeconds({ seconds: index }),
				duration: mediaTimeFromSeconds({ seconds: 1 }),
				trimStart: mediaTimeFromSeconds({ seconds: index * 2 }),
				trimEnd: ZERO_MEDIA_TIME,
				params: { volume: -index },
			}),
		);
		tracks.audio.push({
			id: "audio",
			name: "audio",
			type: "audio",
			muted: false,
			elements,
		});
		const result = await collectAudioElements({
			tracks,
			mediaAssets: [asset],
			audioContext,
		});
		expect(decodes).toBe(1);
		expect(result).toHaveLength(24);
		expect(new Set(result.map((entry) => entry.buffer)).size).toBe(1);
		expect(result.map((entry) => entry.trimStart)).toEqual(
			Array.from({ length: 24 }, (_, index) => index * 2),
		);
		expect(result.map((entry) => entry.volume)).toEqual(
			Array.from({ length: 24 }, (_, index) => 10 ** (-index / 20)),
		);
		// The lifetime is one export: a fresh invocation decodes again, while
		// explicitly muted elements cause no work even if their source is unique.
		await collectAudioElements({ tracks, mediaAssets: [asset], audioContext });
		expect(decodes).toBe(2);
		elements.forEach((element) => {
			element.params.muted = true;
		});
		expect(
			await collectAudioElements({
				tracks,
				mediaAssets: [asset],
				audioContext,
			}),
		).toEqual([]);
		expect(decodes).toBe(2);
	});

	test("unique sources use at most two concurrent decoders; rejected source releases its slot", async () => {
		const cache = createExportAudioDecodeCache<number>();
		let active = 0;
		let peak = 0;
		let calls = 0;
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, key) =>
				cache({
					key: String(key),
					decode: async () => {
						calls++;
						active++;
						peak = Math.max(peak, active);
						await new Promise((resolve) => setTimeout(resolve, 2));
						active--;
						if (key === 0) throw new Error("bad source");
						return key;
					},
				}),
			),
		);
		expect(calls).toBe(10);
		expect(peak).toBe(2);
		expect(
			results.filter((entry) => entry.status === "fulfilled"),
		).toHaveLength(9);
	});
});
