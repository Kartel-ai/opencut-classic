import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";

function exactStudioOrigin(raw: string | undefined): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		)
			return null;
		return url.origin;
	} catch {
		return null;
	}
}

const configuredStudioOrigin = process.env.NEXT_PUBLIC_KARTEL_STUDIO_ORIGIN;
const kartelStudioOrigin = exactStudioOrigin(configuredStudioOrigin);
if (configuredStudioOrigin && !kartelStudioOrigin) {
	throw new Error(
		"NEXT_PUBLIC_KARTEL_STUDIO_ORIGIN must be one exact HTTPS origin (or loopback HTTP for local development).",
	);
}

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "standalone",
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
	async headers() {
		return [
			{
				source: "/kartel/editor/:path*",
				headers: [
					{
						key: "Content-Security-Policy",
						value: `frame-ancestors ${kartelStudioOrigin ?? "'none'"}`,
					},
					{ key: "Referrer-Policy", value: "no-referrer" },
				],
			},
		];
	},
};

export default withContentCollections(withBotId(nextConfig));
