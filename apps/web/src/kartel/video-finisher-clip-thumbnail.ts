"use client";

import { useEffect, useState } from "react";
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { MediaAsset } from "@/media/types";
import { kartelClipFrameKey } from "./video-finisher-clip-frame";

// DF-048: one small frame per piece of a split source, decoded from the media file the editor
// already holds. Decodes run one at a time and each frame is kept for the session.
const FRAME_HEIGHT = 120;
const MAX_FRAMES = 240;
const frames = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

async function decodeFrame({ file, seconds }: { file: File; seconds: number }): Promise<string | null> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track || !(await track.canDecode())) return null;
		const sample = await new VideoSampleSink(track).getSample(seconds);
		if (!sample) return null;
		try {
			const height = Math.min(FRAME_HEIGHT, track.displayHeight);
			const width = Math.max(1, Math.round((track.displayWidth / track.displayHeight) * height));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (!context) return null;
			sample.draw(context, 0, 0, width, height);
			return canvas.toDataURL("image/jpeg", 0.75);
		} finally {
			sample.close();
		}
	} finally {
		input.dispose();
	}
}

function clipFrame({ key, file, seconds }: { key: string; file: File; seconds: number }): Promise<string | null> {
	const cached = frames.get(key);
	if (cached) return cached;
	const job = queue.then(() => decodeFrame({ file, seconds })).catch(() => null);
	queue = job;
	frames.set(key, job);
	if (frames.size > MAX_FRAMES) {
		const oldest = frames.keys().next().value;
		if (oldest !== undefined) frames.delete(oldest);
	}
	return job;
}

// The frame for one piece, or null until it is decoded (the caller keeps OpenCut's thumbnail).
export function useKartelClipFrame({ asset, seconds }: { asset: MediaAsset | undefined; seconds: number }): string | null {
	const key = asset?.type === "video" && asset.file ? kartelClipFrameKey({ mediaId: asset.id, seconds }) : null;
	const file = asset?.file ?? null;
	const [frame, setFrame] = useState<{ key: string; url: string | null } | null>(null);
	useEffect(() => {
		if (!key || !file) return;
		let alive = true;
		void clipFrame({ key, file, seconds }).then((url) => {
			if (alive) setFrame({ key, url });
		});
		return () => {
			alive = false;
		};
	}, [key, file, seconds]);
	return frame && frame.key === key ? frame.url : null;
}
