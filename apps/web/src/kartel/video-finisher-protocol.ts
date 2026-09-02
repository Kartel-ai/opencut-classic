export const VIDEO_FINISHER_BRIDGE = "kartel-video-finisher" as const;
export const VIDEO_FINISHER_BRIDGE_VERSION = 1 as const;

export function isKartelVideoFinisherRoute(pathname: string) {
	return /^\/kartel\/editor\/[^/]+\/?$/.test(pathname);
}

export function shouldShowStandaloneEditorChrome(pathname: string) {
	return !isKartelVideoFinisherRoute(pathname);
}

export function shouldShowEditorMobileGate(pathname: string) {
	return !isKartelVideoFinisherRoute(pathname);
}

// Host → editor message types. Preview and marker operations stay transient until the host explicitly saves.
export const VIDEO_FINISHER_HOST_MESSAGE_TYPES = [
	"LOAD_PROJECT",
	"SAVE_PROJECT",
	"INSERT_REPLACEMENT",
	"OBSERVE_REPLACEMENT",
	"EXPORT_PROJECT",
	"OBSERVE_EXPORT",
	"RELEASE_EXPORT",
	"PREVIEW_RANGE",
	"SET_MARKERS",
] as const;

export type VideoFinisherHostMessage = {
	bridge: typeof VIDEO_FINISHER_BRIDGE;
	version: typeof VIDEO_FINISHER_BRIDGE_VERSION;
	type: (typeof VIDEO_FINISHER_HOST_MESSAGE_TYPES)[number];
	nonce: string;
	projectId: string;
	revision: number;
	operationId: string;
	payload?: Record<string, unknown> | null;
};

export type VideoFinisherBridgeIdentity = Pick<
	VideoFinisherHostMessage,
	"nonce" | "projectId" | "revision" | "operationId"
>;

export function buildVideoFinisherBridgeMessage({
	type,
	identity,
	payload = null,
}: {
	type: string;
	identity: VideoFinisherBridgeIdentity;
	payload?: unknown;
}) {
	return {
		bridge: VIDEO_FINISHER_BRIDGE,
		version: VIDEO_FINISHER_BRIDGE_VERSION,
		type,
		nonce: identity.nonce,
		projectId: identity.projectId,
		revision: identity.revision,
		operationId: identity.operationId,
		payload,
	};
}
