"use client";

import { useEffect, useState, type RefObject } from "react";
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { MediaAsset } from "@/media/types";
import {
	ClipThumbnailQueue,
	type ThumbnailDecoder,
} from "./video-finisher-thumbnail-queue";

const FRAME_HEIGHT = 120;

export async function openClipThumbnailDecoder(
	file: File,
): Promise<ThumbnailDecoder> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track || !(await track.canDecode()))
			throw new Error("Video thumbnail is unavailable");
		const sink = new VideoSampleSink(track);
		return {
			dispose: () => input.dispose(),
			async frames(seconds) {
				const frames: Array<string | null> = [];
				const height = Math.min(FRAME_HEIGHT, track.displayHeight);
				const width = Math.max(
					1,
					Math.round((track.displayWidth / track.displayHeight) * height),
				);
				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				const context = canvas.getContext("2d");
				if (!context) return seconds.map(() => null);
				// getSample() creates a codec per call. The timestamp iterator instead
				// owns one decoder for the sorted batch and closes it when exhausted.
				for await (const sample of sink.samplesAtTimestamps(seconds)) {
					if (!sample) {
						frames.push(null);
						continue;
					}
					try {
						sample.draw(context, 0, 0, width, height);
						frames.push(canvas.toDataURL("image/jpeg", 0.75));
					} finally {
						sample.close();
					}
				}
				return frames;
			},
		};
	} catch (error) {
		input.dispose();
		throw error;
	}
}

const thumbnails = new ClipThumbnailQueue(openClipThumbnailDecoder);
export function clearKartelClipFrames() {
	thumbnails.dispose();
}

// Observe the clip itself so scroll clipping excludes offscreen clips. OpenCut's
// existing thumbnail stays painted until the requested source frame is ready.
export function useKartelClipFrame({
	asset,
	seconds,
	elementRef,
}: {
	asset: MediaAsset | undefined;
	seconds: number;
	elementRef: RefObject<HTMLElement | null>;
}): string | null {
	const file = asset?.type === "video" ? asset.file : null;
	const [visible, setVisible] = useState(
		() => typeof IntersectionObserver === "undefined",
	);
	const [frame, setFrame] = useState<{
		file: File;
		seconds: number;
		url: string | null;
	} | null>(null);
	useEffect(() => {
		const element = elementRef.current;
		if (!element) return;
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(([entry]) =>
			setVisible(entry.isIntersecting),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [elementRef]);
	useEffect(() => {
		if (!file || !visible) return;
		const controller = new AbortController();
		void thumbnails
			.request({ file, seconds, signal: controller.signal })
			.then((url) => {
				if (!controller.signal.aborted) setFrame({ file, seconds, url });
			});
		return () => controller.abort();
	}, [file, seconds, visible]);
	return frame && frame.file === file && frame.seconds === seconds
		? frame.url
		: null;
}
