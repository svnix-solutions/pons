import { timingSafeEqual } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { api } from "../../../../../convex/_generated/api";

/**
 * Media bridge → Pons correlation endpoint (Phase 3).
 *
 * The self-hosted media bridge (Asterisk → Dograh) calls this once it has
 * bridged a WhatsApp call's audio into a Dograh session, to attach the Dograh
 * session id (and optionally a status) onto the Pons `calls` record.
 *
 * Auth: shared secret in the `x-pons-media-secret` header, timing-safe compared
 * to MEDIA_BRIDGE_SECRET. The Convex action re-checks the same secret as
 * defense-in-depth (mirroring how the webhook route defers signature checks to
 * Convex). This endpoint carries NO audio — only the session id and status.
 */

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
	throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
}
const convex = new ConvexHttpClient(convexUrl);

const bodySchema = z.object({
	waCallId: z.string().min(1),
	dograhSessionId: z.string().min(1),
	status: z
		.enum([
			"connecting",
			"connected",
			"completed",
			"terminated",
			"rejected",
			"failed",
		])
		.optional(),
});

export async function POST(request: NextRequest) {
	const provided = request.headers.get("x-pons-media-secret");
	if (!provided) {
		return new NextResponse("Missing secret", { status: 401 });
	}

	const expected = process.env.MEDIA_BRIDGE_SECRET;
	if (!expected) {
		console.error("[media:POST] ✗ MEDIA_BRIDGE_SECRET env var not set");
		return new NextResponse("Server misconfigured", { status: 500 });
	}

	// Timing-safe comparison (equal-length buffers only).
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return new NextResponse("Unauthorized", { status: 401 });
	}

	let parsed: z.infer<typeof bodySchema>;
	try {
		parsed = bodySchema.parse(await request.json());
	} catch (error) {
		if (error instanceof z.ZodError) {
			return new NextResponse("Invalid payload", { status: 400 });
		}
		return new NextResponse("Invalid JSON", { status: 400 });
	}

	try {
		const result = await convex.action(api.gateway.attachCallSession, {
			secret: expected,
			waCallId: parsed.waCallId,
			dograhSessionId: parsed.dograhSessionId,
			status: parsed.status,
		});

		if (!result.found) {
			return NextResponse.json(
				{ ok: false, error: "call_not_found" },
				{ status: 404 },
			);
		}
		return NextResponse.json({ ok: true, callId: result.callId });
	} catch (error) {
		console.error("[media:POST] ✗ Failed to attach session", {
			waCallId: parsed.waCallId,
			error: String(error),
		});
		return new NextResponse("Internal error", { status: 500 });
	}
}
