import { describe, expect, test } from "bun:test";
import { createTimelineAudioBuffer } from "../audio";
import { buildDefaultScene } from "@/timeline/scenes";
import { TICKS_PER_SECOND } from "@/wasm";

describe("createTimelineAudioBuffer", () => {
	test("creates duration-matched stereo silence only when an export requires an audio track", async () => {
		const tracks = buildDefaultScene({ name: "Main scene", isMain: true }).tracks;
		const calls: Array<{ channels: number; length: number; sampleRate: number }> = [];
		// This focused double needs only the API exercised by an empty timeline.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const audioContext = {
			// AudioContext owns this positional browser API; the test records its exact call.
			// eslint-disable-next-line opencut/prefer-object-params
			createBuffer(channels: number, length: number, sampleRate: number) {
				calls.push({ channels, length, sampleRate });
				return { numberOfChannels: channels, length, sampleRate };
			},
		} as unknown as AudioContext;

		const ordinary = await createTimelineAudioBuffer({
			tracks,
			mediaAssets: [],
			duration: 2 * TICKS_PER_SECOND,
			audioContext,
		});
		expect(ordinary).toBeNull();
		expect(calls).toEqual([]);

		const required = await createTimelineAudioBuffer({
			tracks,
			mediaAssets: [],
			duration: 2 * TICKS_PER_SECOND,
			audioContext,
			silenceWhenEmpty: true,
		});
		expect(required).not.toBeNull();
		expect(calls).toEqual([
			{ channels: 2, length: 88_200, sampleRate: 44_100 },
		]);
	});
});
