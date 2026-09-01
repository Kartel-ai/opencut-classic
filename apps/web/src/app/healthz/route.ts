export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(
		{
			ok: true,
			service: "kartel-video-finisher-editor",
			commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
		},
		{
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}
