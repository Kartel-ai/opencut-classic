import { expect, test } from "bun:test";
import { createProjectMediaForHost } from "../video-finisher-media";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";

test("checkpoint acknowledgement omits unchanged immutable media only in the current bridge", () => {
	const send = createProjectMediaForHost();
	const fileOf = (entry: ReturnType<typeof send>[number]) =>
		"file" in entry ? entry.file : undefined;
	const file = new File(["pixels"], "image.png", { type: "image/png" });
	const asset = {
		id: "image",
		name: file.name,
		type: "image",
		file,
		url: "blob:image",
	} as MediaAsset;
	// This double exercises only the referenced-media inventory read by the bridge.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const project = {
		scenes: [
			{
				tracks: {
					main: { elements: [{ mediaId: asset.id }] },
					overlay: [],
					audio: [],
				},
			},
		],
	} as unknown as TProject;
	const args = { project, assets: [asset], sourceId: "source" };
	const initial = send(args)[0];
	expect(fileOf(initial)).toBeInstanceOf(File);
	const retainedMedia = [
		{
			id: asset.id,
			contentToken: initial.contentToken!,
			sha256: "a".repeat(64),
			sizeBytes: file.size,
			mimeType: file.type,
			name: file.name,
		},
	];
	const warm = send({ ...args, retainedMedia })[0];
	expect(warm.retained).toBe(true);
	expect(fileOf(warm)).toBeUndefined();
	expect(
		fileOf(
			send({
				...args,
				retainedMedia: [{ ...retainedMedia[0], name: "wrong.png" }],
			})[0],
		),
	).toBeInstanceOf(File);
	expect(
		fileOf(createProjectMediaForHost()({ ...args, retainedMedia })[0]),
	).toBeInstanceOf(File);
	const replacement = {
		...asset,
		file: new File(["pixels"], file.name, { type: file.type }),
	};
	expect(
		fileOf(send({ ...args, assets: [replacement], retainedMedia })[0]),
	).toBeInstanceOf(File);
});
