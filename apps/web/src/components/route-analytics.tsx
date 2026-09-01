"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { isKartelVideoFinisherRoute } from "@/kartel/video-finisher-protocol";

export function RouteAnalytics({ disabled }: { disabled: boolean }) {
	const pathname = usePathname();
	if (isKartelVideoFinisherRoute(pathname)) return null;

	return (
		<Script
			src="https://cdn.databuddy.cc/databuddy.js"
			strategy="afterInteractive"
			async
			data-client-id="UP-Wcoy5arxFeK7oyjMMZ"
			data-disabled={disabled}
			data-track-attributes={false}
			data-track-errors={true}
			data-track-outgoing-links={false}
			data-track-web-vitals={false}
			data-track-sessions={false}
		/>
	);
}
