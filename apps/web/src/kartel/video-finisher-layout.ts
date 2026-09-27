import { create } from "zustand";
import { isKartelVideoFinisherRoute } from "./video-finisher-protocol";

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
	setCompact: (compact: boolean) => void;
};

export const useKartelLayout = create<KartelLayoutState>((set) => ({
	compact: initialCompact(),
	embedded: isKartelEmbedded(),
	setCompact: (compact) => set({ compact }),
}));
