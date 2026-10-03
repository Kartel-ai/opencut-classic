import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks } from "@/timeline";

// READY can arrive twice during embed mounting. A project restore replaces the
// media collection, so complete it before another restore can inspect/import it.
export function createProjectLoadQueue() {
	let tail = Promise.resolve();
	return <T>(load: () => Promise<T>): Promise<T> => {
		const result = tail.then(load);
		tail = result.then(
			() => {},
			() => {},
		);
		return result;
	};
}

export function referencedMediaIds(
	scenes: { tracks: SceneTracks }[],
): string[] {
	return [
		...new Set(
			scenes.flatMap(({ tracks }) =>
				[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
					track.elements.flatMap((element) =>
						"mediaId" in element ? [element.mediaId] : [],
					),
				),
			),
		),
	];
}

export function requireProjectMedia({
	scenes,
	assets,
}: {
	scenes: { tracks: SceneTracks }[];
	assets: MediaAsset[];
}) {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	return referencedMediaIds(scenes).map((id) => {
		const asset = byId.get(id);
		if (!asset?.file || !asset.url) {
			throw new Error(
				"Required project media is missing. Restore every referenced file before saving or exporting.",
			);
		}
		return asset;
	});
}

export type RetainedProjectMedia = {
	id: string;
	contentToken: string;
	sha256: string;
	sizeBytes: number;
	mimeType: string;
	name: string;
};

// Tokens are scoped to one mounted bridge, never a durable media identity. A new
// immutable File or changed metadata gets a new token and must be verified by
// Studio again. Studio acknowledges only a manifest it has already checkpointed.
export function createProjectMediaForHost() {
	const tokens = new WeakMap<File, Map<string, string>>();
	return (args: ProjectMediaForHostArgs) =>
		projectMediaForHost({
			...args,
			contentTokenFor: ({ file, name, mimeType }) => {
				let metadataTokens = tokens.get(file);
				if (!metadataTokens) {
					metadataTokens = new Map();
					tokens.set(file, metadataTokens);
				}
				const key = JSON.stringify([name, mimeType]);
				let token = metadataTokens.get(key);
				if (!token) {
					token = crypto.randomUUID();
					metadataTokens.set(key, token);
				}
				return token;
			},
		});
}

type ProjectMediaForHostArgs = {
	project: TProject;
	assets: MediaAsset[];
	sourceId: string | null;
	retainedMedia?: unknown;
};

export function projectMediaForHost({
	project,
	assets,
	sourceId,
	retainedMedia,
	contentTokenFor,
}: ProjectMediaForHostArgs & {
	contentTokenFor?: (args: {
		file: File;
		name: string;
		mimeType: string;
	}) => string;
}) {
	const media = requireProjectMedia({ scenes: project.scenes, assets }).filter(
		(asset) => asset.id !== sourceId,
	);
	if (
		media.length > 64 ||
		media.reduce((total, asset) => total + asset.file.size, 0) >
			100 * 1024 * 1024
	) {
		throw new Error(
			"Imported project media exceeds the 100 MB recovery limit.",
		);
	}
	// OPFS names files by media ID and does not retain File.type. Restore the
	// original metadata for transport; Studio still checks the uploaded bytes.
	const mimeByExtension: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		webp: "image/webp",
		gif: "image/gif",
		avif: "image/avif",
		mp4: "video/mp4",
		mov: "video/quicktime",
		webm: "video/webm",
		wav: "audio/wav",
		mp3: "audio/mpeg",
	};
	const acknowledged: unknown[] =
		Array.isArray(retainedMedia) && retainedMedia.length <= 64
			? retainedMedia
			: [];
	return media.map((asset) => {
		const mimeType =
			asset.file.type ||
			mimeByExtension[asset.name.split(".").pop()?.toLowerCase() ?? ""] ||
			"";
		const contentToken = contentTokenFor?.({
			file: asset.file,
			name: asset.name,
			mimeType,
		});
		const previous =
			contentToken &&
			acknowledged.find(
				(entry): entry is RetainedProjectMedia =>
					typeof entry === "object" &&
					entry !== null &&
					"id" in entry &&
					entry.id === asset.id &&
					"contentToken" in entry &&
					entry.contentToken === contentToken &&
					"sizeBytes" in entry &&
					entry.sizeBytes === asset.file.size &&
					"mimeType" in entry &&
					entry.mimeType === mimeType &&
					"name" in entry &&
					entry.name === asset.name &&
					"sha256" in entry &&
					typeof entry.sha256 === "string" &&
					/^[0-9a-f]{64}$/.test(entry.sha256),
			);
		if (previous)
			return {
				id: asset.id,
				contentToken,
				retained: true as const,
				sha256: previous.sha256,
				sizeBytes: asset.file.size,
				mimeType,
				name: asset.name,
			};
		return {
			id: asset.id,
			...(contentToken ? { contentToken } : {}),
			file: new File([asset.file], asset.name, {
				type: mimeType,
				lastModified: asset.file.lastModified,
			}),
		};
	});
}
