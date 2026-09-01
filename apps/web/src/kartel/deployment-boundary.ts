const KARTEL_EDITOR_PATH = /^\/kartel\/editor\/[^/]+\/?$/;

export function isKartelEmbedOnly(
	env: { KARTEL_EMBED_ONLY?: string } = {
		KARTEL_EMBED_ONLY: process.env.KARTEL_EMBED_ONLY,
	},
): boolean {
	return env.KARTEL_EMBED_ONLY === "true";
}

export function isKartelServicePath(pathname: string): boolean {
	return pathname === "/healthz" || KARTEL_EDITOR_PATH.test(pathname);
}
