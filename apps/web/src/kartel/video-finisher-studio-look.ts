// RS-283 (Elliot, 2026-10-10, approved on the mock): inside Studio the editor looks like Studio.
// It opens in Studio's theme (`kartel_theme`), a later change arrives with SET_LAYOUT, and the
// compact timeline is as tall as its lanes so the preview leads.

export type KartelTheme = "light" | "dark";

export function normalizedKartelTheme(value: unknown): KartelTheme | null {
	return value === "light" || value === "dark" ? value : null;
}

export function kartelThemeFromSearch(search: string): KartelTheme | null {
	return normalizedKartelTheme(new URLSearchParams(search).get("kartel_theme"));
}

// RS-313 (Elliot, 2026-10-14, approved on the mock): Studio draws the shots under the picture, so the
// embed can open as the picture alone (`kartel_timeline=hidden`); `Timeline` brings the lanes back.
export type KartelLayout = "stage" | "compact" | "full";

export function kartelTimelineShownFromSearch(search: string): boolean {
	return new URLSearchParams(search).get("kartel_timeline") !== "hidden";
}

export function kartelLayoutState(layout: unknown): { compact: boolean; timeline: boolean } | null {
	if (layout === "stage") return { compact: true, timeline: false };
	if (layout === "compact") return { compact: true, timeline: true };
	if (layout === "full") return { compact: false, timeline: true };
	return null;
}

// The toolbar and ruler take 132px; each lane its own height. The share is of the frame's live
// height (it was read from innerHeight once per render, so a frame that opened short kept a 62%
// timeline after it grew), between 18% and 62%.
export function kartelTimelineShare({ lanePixels, frameHeight }: { lanePixels: number; frameHeight: number }): number {
	if (!Number.isFinite(frameHeight) || frameHeight <= 0) return 36;
	const lanes = Number.isFinite(lanePixels) && lanePixels > 0 ? lanePixels : 71;
	return Math.min(62, Math.max(18, ((132 + lanes) / frameHeight) * 100));
}
