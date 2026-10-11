import { create } from "zustand";
import { isKartelVideoFinisherRoute } from "./video-finisher-protocol";
import { kartelThemeFromSearch, type KartelTheme } from "./video-finisher-studio-look";

// RS-067 mock: inside Studio the editor opens as preview and timeline only. The host switches to
// OpenCut's full panels (assets and properties) through SET_LAYOUT from its Advanced control.
// Solo state lives on persisted timeline tracks so undo and reload preserve the original mix.

function initialCompact(): boolean {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("kartel_layout") === "compact";
}

// DF-049 Advanced switch: inside Studio in either layout. Media enters only through Studio's Asset
// Library (an OpenCut import has no Library version and cannot be saved), and clips keep the shot
// names Studio gave them.
export function isKartelEmbedded(): boolean {
	return typeof window !== "undefined" && isKartelVideoFinisherRoute(window.location.pathname);
}

type KartelLayoutState = {
	compact: boolean;
	embedded: boolean;
	// RS-283: Studio's theme, from kartel_theme at open and SET_LAYOUT after; null keeps OpenCut's.
	theme: KartelTheme | null;
	setCompact: (compact: boolean) => void;
	setTheme: (theme: KartelTheme) => void;
};

// RS-283: mark the document and hand Studio's theme to next-themes before the editor renders, so
// the frame does not open in OpenCut's own colours and then switch.
if (typeof window !== "undefined" && isKartelEmbedded()) {
	document.documentElement.dataset.kartelEmbed = "";
	const opening = kartelThemeFromSearch(window.location.search);
	if (opening) {
		try {
			window.localStorage.setItem("theme", opening);
		} catch {}
	}
}

export const useKartelLayout = create<KartelLayoutState>((set) => ({
	compact: initialCompact(),
	embedded: isKartelEmbedded(),
	theme: typeof window === "undefined" ? null : kartelThemeFromSearch(window.location.search),
	setCompact: (compact) => set({ compact }),
	setTheme: (theme) => set({ theme }),
}));
