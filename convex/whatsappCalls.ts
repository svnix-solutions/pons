/**
 * WhatsApp Business Calling — control plane actions.
 *
 * Mirrors convex/whatsapp.ts (messaging) but for voice calls. These actions
 * talk to the Meta Graph API and record lifecycle in the `calls` table via
 * convex/calls.ts. They do NOT handle audio — media flows
 * WhatsApp → SIP/Asterisk → Dograh, entirely outside Convex (see Phase 3).
 *
 * Endpoints (Meta Cloud API):
 *   - Call Permission Request: POST /{phone-number-id}/messages
 *       type=interactive, interactive.type=call_permission_request
 *   - Connect / terminate:     POST /{phone-number-id}/calls  (action enum)
 *
 * Consent model: a business may place up to 5 calls / 24h for a 7-day window
 * after the user grants permission via the permission request message.
 *
 * NOTE: initiateCall requires an SDP offer produced by the media layer, which
 * does not exist until Phase 3. Until then this action is structurally complete
 * but cannot be exercised end-to-end.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { MetaApiRequestError, metaFetch } from "./metaFetch";

// Standard Meta send response (permission request goes through /messages).
type MetaMessagesResponse = { messages?: Array<{ id: string }> };
// POST /{phone-number-id}/calls connect response.
type MetaCallsResponse = { calls?: Array<{ id: string }> };
// POST /{phone-number-id}/calls terminate response.
type MetaCallActionResponse = { success?: boolean };

/**
 * Resolve the Facebook OAuth token for an account's owner.
 * Same pattern as convex/whatsapp.ts (kept local — that copy is not exported).
 */
// biome-ignore lint/suspicious/noExplicitAny: Convex action ctx type is complex
async function resolveAccessToken(ctx: any, ownerId: string): Promise<string> {
	const token: string | null = await ctx.runQuery(
		internal.whatsappDiscovery.getFacebookToken,
		{ userId: ownerId },
	);
	if (!token) {
		throw new Error(
			"No Facebook access token found for account owner. The owner needs to re-authenticate.",
		);
	}
	return token;
}

/**
 * Fetch an account and assert it is usable for calling.
 * Returns the phone number id and a resolved access token.
 */
async function resolveCallingAccount(
	ctx: ActionCtx,
	accountId: Id<"accounts">,
) {
	const account = await ctx.runQuery(internal.accounts.getInternal, {
		accountId,
	});
	if (!account) throw new Error("Account not found");
	if (!account.phoneNumberId) {
		throw new Error(
			"Account has no phone number ID — registration may be incomplete",
		);
	}
	if (account.status !== "active" && account.status !== "pending_name_review") {
		throw new Error(`Account is not active (status: ${account.status})`);
	}
	const accessToken = await resolveAccessToken(ctx, account.ownerId);
	return { phoneNumberId: account.phoneNumberId, accessToken };
}

const errorCodeOf = (error: unknown): string | undefined =>
	error instanceof MetaApiRequestError ? error.meta.code.toString() : undefined;

/**
 * Send a Call Permission Request — the consent gate for business-initiated
 * calls. Must be sent inside an open 24h service window (or as an approved
 * template; this action uses the free-form interactive form).
 */
export const requestCallPermission = internalAction({
	args: {
		accountId: v.id("accounts"),
		to: v.string(), // E.164
		bodyText: v.optional(v.string()),
		conversationId: v.optional(v.id("conversations")),
		contactId: v.optional(v.id("contacts")),
	},
	handler: async (ctx, args): Promise<{ callId: Id<"calls"> }> => {
		const { phoneNumberId, accessToken } = await resolveCallingAccount(
			ctx,
			args.accountId,
		);

		const callId = await ctx.runMutation(internal.calls.createCallInternal, {
			accountId: args.accountId,
			conversationId: args.conversationId,
			contactId: args.contactId,
			direction: "outbound",
			to: args.to,
			status: "permission_requested",
			requestedAt: Date.now(),
		});

		try {
			await metaFetch<MetaMessagesResponse>(
				`${phoneNumberId}/messages`,
				accessToken,
				{
					method: "POST",
					body: {
						messaging_product: "whatsapp",
						recipient_type: "individual",
						to: args.to,
						type: "interactive",
						interactive: {
							type: "call_permission_request",
							action: { name: "call_permission_request" },
							body: {
								text:
									args.bodyText ??
									"We'd like to call you on WhatsApp. Allow calls from us?",
							},
						},
					},
					tokenInBody: false,
				},
			);

			await ctx.runMutation(internal.forwarding.enqueueEvent, {
				accountId: args.accountId,
				eventType: "call.permission.requested",
				source: "pons_send",
				payload: { callId, to: args.to, timestamp: Date.now() },
			});

			return { callId };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			await ctx.runMutation(internal.calls.patchCallInternal, {
				callId,
				accountId: args.accountId,
				status: "failed",
				errorCode: errorCodeOf(error),
				errorMessage,
				endedAt: Date.now(),
			});
			throw error;
		}
	},
});

/**
 * Initiate a business-initiated call. Requires prior consent and an SDP offer
 * from the media layer (Phase 3). Returns the created call record id; Meta's
 * call id (wacid...) is stored on it once the connect request is accepted.
 */
export const initiateCall = internalAction({
	args: {
		accountId: v.id("accounts"),
		to: v.string(), // E.164
		sdpOffer: v.string(), // RFC 8866 SDP produced by the media server
		conversationId: v.optional(v.id("conversations")),
		contactId: v.optional(v.id("contacts")),
		callbackData: v.optional(v.string()), // biz_opaque_callback_data
	},
	handler: async (
		ctx,
		args,
	): Promise<{ callId: Id<"calls">; waCallId: string }> => {
		const { phoneNumberId, accessToken } = await resolveCallingAccount(
			ctx,
			args.accountId,
		);

		const callId = await ctx.runMutation(internal.calls.createCallInternal, {
			accountId: args.accountId,
			conversationId: args.conversationId,
			contactId: args.contactId,
			direction: "outbound",
			to: args.to,
			status: "initiated",
			callbackData: args.callbackData,
			initiatedAt: Date.now(),
		});

		try {
			const body: Record<string, unknown> = {
				messaging_product: "whatsapp",
				to: args.to,
				action: "connect",
				session: { sdp_type: "offer", sdp: args.sdpOffer },
			};
			if (args.callbackData) body.biz_opaque_callback_data = args.callbackData;

			const data = await metaFetch<MetaCallsResponse>(
				`${phoneNumberId}/calls`,
				accessToken,
				{ method: "POST", body, tokenInBody: false },
			);

			const waCallId = data.calls?.[0]?.id;
			if (!waCallId) {
				throw new Error(
					"Meta did not return a call id for the connect request",
				);
			}

			await ctx.runMutation(internal.calls.patchCallInternal, {
				callId,
				accountId: args.accountId,
				waCallId,
			});

			await ctx.runMutation(internal.forwarding.enqueueEvent, {
				accountId: args.accountId,
				eventType: "call.initiated",
				source: "pons_send",
				dedupeKey: waCallId,
				payload: {
					callId,
					waCallId,
					to: args.to,
					conversationId: args.conversationId,
					timestamp: Date.now(),
				},
			});

			return { callId, waCallId };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			await ctx.runMutation(internal.calls.patchCallInternal, {
				callId,
				accountId: args.accountId,
				status: "failed",
				errorCode: errorCodeOf(error),
				errorMessage,
				endedAt: Date.now(),
			});

			await ctx.runMutation(internal.forwarding.enqueueEvent, {
				accountId: args.accountId,
				eventType: "call.failed",
				source: "pons_send",
				payload: {
					callId,
					to: args.to,
					errorCode: errorCodeOf(error),
					errorMessage,
					timestamp: Date.now(),
				},
			});
			throw error;
		}
	},
});

/**
 * Terminate an in-progress call by Meta's call id (wacid...).
 * Idempotent-ish: if the call record is unknown we still send the API request.
 */
export const terminateCall = internalAction({
	args: {
		accountId: v.id("accounts"),
		waCallId: v.string(),
	},
	handler: async (ctx, args): Promise<{ success: boolean }> => {
		const { phoneNumberId, accessToken } = await resolveCallingAccount(
			ctx,
			args.accountId,
		);

		const data = await metaFetch<MetaCallActionResponse>(
			`${phoneNumberId}/calls`,
			accessToken,
			{
				method: "POST",
				body: {
					messaging_product: "whatsapp",
					call_id: args.waCallId,
					action: "terminate",
				},
				tokenInBody: false,
			},
		);

		const call = await ctx.runQuery(internal.calls.getCallByWaId, {
			waCallId: args.waCallId,
		});
		if (call && call.accountId === args.accountId) {
			await ctx.runMutation(internal.calls.patchCallInternal, {
				callId: call._id,
				accountId: args.accountId,
				status: "terminated",
				endedAt: Date.now(),
			});

			await ctx.runMutation(internal.forwarding.enqueueEvent, {
				accountId: args.accountId,
				eventType: "call.terminated",
				source: "pons_send",
				dedupeKey: `${args.waCallId}:terminated`,
				payload: {
					callId: call._id,
					waCallId: args.waCallId,
					timestamp: Date.now(),
				},
			});
		}

		return { success: data.success ?? true };
	},
});
