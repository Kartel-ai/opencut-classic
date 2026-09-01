import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
	isKartelEmbedOnly,
	isKartelServicePath,
} from "@/kartel/deployment-boundary";

export function proxy(request: NextRequest) {
	if (!isKartelEmbedOnly() || isKartelServicePath(request.nextUrl.pathname)) {
		return NextResponse.next();
	}

	return new NextResponse("Not Found", {
		status: 404,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)"],
};
