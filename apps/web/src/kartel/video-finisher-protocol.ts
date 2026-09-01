export const VIDEO_FINISHER_BRIDGE = "kartel-video-finisher" as const;
export const VIDEO_FINISHER_BRIDGE_VERSION = 1 as const;

export function isKartelVideoFinisherRoute(pathname: string) {
	return /^\/kartel\/editor\/[^/]+\/?$/.test(pathname);
}

export type VideoFinisherHostMessage = {
	bridge: typeof VIDEO_FINISHER_BRIDGE;
	version: typeof VIDEO_FINISHER_BRIDGE_VERSION;
	type: "LOAD_PROJECT" | "SAVE_PROJECT" | "INSERT_REPLACEMENT" | "OBSERVE_REPLACEMENT" | "EXPORT_PROJECT";
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
