import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks } from "@/timeline";

// READY can arrive twice during embed mounting. A project restore replaces the
// media collection, so complete it before another restore can inspect/import it.
export function createProjectLoadQueue() {
  let tail = Promise.resolve();
  return <T>(load: () => Promise<T>): Promise<T> => {
    const result = tail.then(load);
    tail = result.then(() => {}, () => {});
    return result;
  };
}

export function referencedMediaIds(scenes: { tracks: SceneTracks }[]): string[] {
	return [...new Set(scenes.flatMap(({ tracks }) =>
		[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
			track.elements.flatMap((element) => "mediaId" in element ? [element.mediaId] : []),
		),
	))];
}

export function requireProjectMedia({ scenes, assets }: { scenes: { tracks: SceneTracks }[]; assets: MediaAsset[] }) {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	return referencedMediaIds(scenes).map((id) => {
		const asset = byId.get(id);
		if (!asset?.file || !asset.url) {
			throw new Error("Required project media is missing. Restore every referenced file before saving or exporting.");
		}
		return asset;
	});
}

export function projectMediaForHost({ project, assets, sourceId }: { project: TProject; assets: MediaAsset[]; sourceId: string | null }) {
	const media = requireProjectMedia({ scenes: project.scenes, assets }).filter((asset) => asset.id !== sourceId);
	if (media.length > 64 || media.reduce((total, asset) => total + asset.file.size, 0) > 100 * 1024 * 1024) {
		throw new Error("Imported project media exceeds the 100 MB recovery limit.");
	}
  // OPFS names files by media ID and does not retain File.type. Restore the
  // original metadata for transport; Studio still checks the uploaded bytes.
  const mimeByExtension: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", avif: "image/avif", mp4: "video/mp4", mov: "video/quicktime",
    webm: "video/webm", wav: "audio/wav", mp3: "audio/mpeg",
  };
  return media.map((asset) => ({
    id: asset.id,
    file: new File([asset.file], asset.name, {
      type: asset.file.type || mimeByExtension[asset.name.split(".").pop()?.toLowerCase() ?? ""] || "",
      lastModified: asset.file.lastModified,
    }),
  }));
}
