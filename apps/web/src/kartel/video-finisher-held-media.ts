// Studio downloads the whole source (and the saved edit's media) before every load, though this
// editor keeps each project's media in its own store between opens (2026-10-27, Elliot: the
// Finisher took about 5 s to open with a video). Studio now asks first which of those exact files
// this editor already holds; the editor hands them back by reference, and Studio checks each one's
// size and SHA-256 before it uses it in place of a download. A file this editor does not hold, or
// holds at another size, is simply left out: Studio downloads it as before.

export const HELD_MEDIA_MAX_ITEMS = 65;

export type HeldMediaRequestItem = { id: string; sizeBytes: number };
export type HeldMediaFile = { id: string; file: Blob };

export function normalizedHeldMediaRequest(payload: unknown): HeldMediaRequestItem[] {
	const items = payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items)
		? (payload as { items: unknown[] }).items
		: null;
	if (!items || items.length < 1 || items.length > HELD_MEDIA_MAX_ITEMS) throw new Error("Studio asked for an invalid list of held media.");
	const seen = new Set<string>();
	return items.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const { id, sizeBytes } = item as { id?: unknown; sizeBytes?: unknown };
		if (typeof id !== "string" || id.length < 1 || id.length > 240 || seen.has(id)) return [];
		if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return [];
		seen.add(id);
		return [{ id, sizeBytes }];
	});
}

// The open project's own media first, then this project's store. A store read that fails is a
// miss, never an error: Studio then reads that file itself.
export async function heldMediaFiles({
	items,
	assets,
	load,
}: {
	items: HeldMediaRequestItem[];
	assets: { id: string; file?: Blob | null }[];
	load: (id: string) => Promise<Blob | null>;
}): Promise<HeldMediaFile[]> {
	const held: HeldMediaFile[] = [];
	for (const item of items) {
		let file = assets.find((asset) => asset.id === item.id)?.file ?? null;
		if (!file) {
			try { file = await load(item.id); } catch { file = null; }
		}
		if (file instanceof Blob && file.size === item.sizeBytes) held.push({ id: item.id, file });
	}
	return held;
}
