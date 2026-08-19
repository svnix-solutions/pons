/**
 * Data layer for WhatsApp voice calls.
 *
 * Internal mutations/queries over the `calls` table, mirroring the split used
 * for messages (convex/messages.ts is the DB layer, convex/whatsapp.ts the Meta
 * actions). The Meta Graph calls live in convex/whatsappCalls.ts and record
 * lifecycle here.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { callDirection, callStatus } from "./schema";

/**
 * Create a call record. Used both when sending a Call Permission Request
 * (no waCallId yet) and when initiating a call.
 */
export const createCallInternal = internalMutation({
	args: {
		accountId: v.id("accounts"),
		conversationId: v.optional(v.id("conversations")),
		contactId: v.optional(v.id("contacts")),
		direction: callDirection,
		to: v.string(),
		status: callStatus,
		callbackData: v.optional(v.string()),
		requestedAt: v.optional(v.number()),
		initiatedAt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<Id<"calls">> => {
		return await ctx.db.insert("calls", {
			accountId: args.accountId,
			conversationId: args.conversationId,
			contactId: args.contactId,
			direction: args.direction,
			to: args.to,
			status: args.status,
			callbackData: args.callbackData,
			requestedAt: args.requestedAt,
			initiatedAt: args.initiatedAt,
		});
	},
});

/**
 * Patch a call record. All fields optional — only provided fields are written.
 * Ownership is validated against accountId to prevent cross-account writes.
 */
export const patchCallInternal = internalMutation({
	args: {
		callId: v.id("calls"),
		accountId: v.id("accounts"),
		status: v.optional(callStatus),
		waCallId: v.optional(v.string()),
		dograhSessionId: v.optional(v.string()),
		permissionExpiresAt: v.optional(v.number()),
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string()),
		initiatedAt: v.optional(v.number()),
		connectedAt: v.optional(v.number()),
		endedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const call = await ctx.db.get(args.callId);
		if (!call || call.accountId !== args.accountId) {
			throw new Error("Call not found");
		}

		const { callId: _callId, accountId: _accountId, ...rest } = args;
		const patch = Object.fromEntries(
			Object.entries(rest).filter(([, value]) => value !== undefined),
		);
		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(args.callId, patch);
		}
		return { callId: args.callId };
	},
});

/** Look up a call by Meta's call id (wacid...). Used by terminate + webhook ingest. */
export const getCallByWaId = internalQuery({
	args: { waCallId: v.string() },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("calls")
			.withIndex("by_wa_call_id", (q) => q.eq("waCallId", args.waCallId))
			.first();
	},
});

/** Get a call by id (internal). */
export const getCallInternal = internalQuery({
	args: { callId: v.id("calls") },
	handler: async (ctx, args) => {
		return await ctx.db.get(args.callId);
	},
});
