import { describe, expect, test } from "bun:test";
import { ClipThumbnailQueue } from "../video-finisher-thumbnail-queue";

describe("visible thumbnail scheduler", () => {
	test("24 cuts reuse one source reader and repeated frames reuse pixels", async () => {
		let batches = 0;
		let opens = 0,
			frames = 0,
			closed = 0;
		const queue = new ClipThumbnailQueue(async () => {
			opens++;
			return {
				frames: async (seconds) => {
					batches++;
					frames += seconds.length;
					expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
					return seconds.map((time) => `frame-${time}`);
				},
				dispose: () => {
					closed++;
				},
			};
		});
		const file = new File(["source"], "source.mp4");
		await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				queue.request({
					file,
					seconds: 23 - index,
					signal: new AbortController().signal,
				}),
			),
		);
		await queue.request({
			file,
			seconds: 10,
			signal: new AbortController().signal,
		});
		expect(opens).toBe(1);
		expect(frames).toBe(24);
		expect(batches).toBe(1);
		queue.dispose();
		expect(closed).toBe(1);
	});

	test("obsolete trims cancel before decoding and an aborted subscriber cannot cancel another", async () => {
		const decoded: number[] = [];
		let closed = 0;
		const queue = new ClipThumbnailQueue(async () => ({
			frames: async (seconds) => {
				decoded.push(...seconds);
				return seconds.map((time) => `frame-${time}`);
			},
			dispose: () => {
				closed++;
			},
		}));
		const file = new File(["source"], "source.mp4");
		const old = new AbortController();
		const cancelled = queue.request({ file, seconds: 1, signal: old.signal });
		old.abort();
		const duplicate = new AbortController();
		const first = queue.request({ file, seconds: 2, signal: duplicate.signal });
		const second = queue.request({
			file,
			seconds: 2,
			signal: new AbortController().signal,
		});
		duplicate.abort();
		expect(await cancelled).toBeNull();
		expect(await first).toBeNull();
		expect(await second).toBe("frame-2");
		expect(decoded).toEqual([2]);
		expect(closed).toBe(0);
		queue.dispose();
	});

	test("leaving the viewport cancels only that subscriber while another visible frame keeps the batch alive", async () => {
		let closed = 0;
		let begin: () => void = () => {};
		let finish: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			begin = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const queue = new ClipThumbnailQueue(async () => ({
			frames: async (seconds) => {
				begin();
				await gate;
				return seconds.map((time) => `frame-${time}`);
			},
			dispose: () => {
				closed++;
			},
		}));
		const file = new File(["source"], "source.mp4");
		const hidden = new AbortController();
		const first = queue.request({ file, seconds: 1, signal: hidden.signal });
		const second = queue.request({
			file,
			seconds: 2,
			signal: new AbortController().signal,
		});
		await started;
		hidden.abort();
		expect(await first).toBeNull();
		expect(closed).toBe(0);
		finish();
		expect(await second).toBe("frame-2");
		queue.dispose();
		expect(closed).toBe(1);
	});

	test("aborting every visible request disposes the active decoder and later requests recover", async () => {
		let closed = 0,
			opens = 0;
		let begin: () => void = () => {};
		let rejectFrame: (error: Error) => void = () => {};
		const started = new Promise<void>((resolve) => {
			begin = resolve;
		});
		const queue = new ClipThumbnailQueue(async () => {
			opens++;
			const firstDecoder = opens === 1;
			let disposed = false;
			return {
				frames: async (seconds) => {
					if (firstDecoder) {
						begin();
						await new Promise<void>((_resolve, reject) => {
							rejectFrame = reject;
						});
					}
					return seconds.map((time) => `frame-${time}`);
				},
				dispose: () => {
					if (!disposed) closed++;
					disposed = true;
					if (firstDecoder) rejectFrame(new Error("disposed"));
				},
			};
		});
		const file = new File(["source"], "source.mp4");
		const controller = new AbortController();
		const pending = queue.request({
			file,
			seconds: 1,
			signal: controller.signal,
		});
		await started;
		controller.abort();
		expect(await pending).toBeNull();
		expect(closed).toBe(1);
		expect(
			await queue.request({
				file,
				seconds: 2,
				signal: new AbortController().signal,
			}),
		).toBe("frame-2");
		expect(opens).toBe(2);
		queue.dispose();
	});

	test("same-name replacement File does not reuse stale pixels and decoder LRU is bounded", async () => {
		let closed = 0;
		const queue = new ClipThumbnailQueue(async (file) => ({
			frames: async (seconds) => Promise.all(seconds.map(() => file.text())),
			dispose: () => {
				closed++;
			},
		}));
		for (const content of ["first", "second", "third"]) {
			const result = await queue.request({
				file: new File([content], "same.mp4"),
				seconds: 1,
				signal: new AbortController().signal,
			});
			expect(result).toBe(content);
		}
		expect(closed).toBe(1);
		queue.dispose();
		expect(closed).toBe(3);
	});
});
