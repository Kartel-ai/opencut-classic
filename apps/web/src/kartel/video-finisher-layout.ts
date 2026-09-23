import { create } from "zustand";

// RS-067 mock: inside Studio the editor opens as preview and timeline only. The host switches to
// OpenCut's full panels (assets and properties) through SET_LAYOUT from its Advanced control.
// Solo state lives on persisted timeline tracks so undo and reload preserve the original mix.

function initialCompact(): boolean {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("kartel_layout") === "compact";
}

type KartelLayoutState = {
	compact: boolean;
	setCompact: (compact: boolean) => void;
};

export const useKartelLayout = create<KartelLayoutState>((set) => ({
	compact: initialCompact(),
	setCompact: (compact) => set({ compact }),
}));
