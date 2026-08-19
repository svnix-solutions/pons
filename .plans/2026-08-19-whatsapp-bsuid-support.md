# WhatsApp BSUID / Username Support Plan

## Goal

Make Pons compatible with WhatsApp **usernames** and **Business-Scoped User IDs
(BSUID)**, which Meta now requires for all partners and directly-integrated
businesses.

Concretely:

- Stop dropping username-only inbound messages in the webhook parser.
- Store an opaque, phone-optional routing identity (BSUID) per contact.
- Send to a BSUID (`recipient`) when no phone number is available.
- Keep the identity model channel-neutral so a future Telegram integration
  (which addresses by `chat_id`, not phone) reuses the same shape.

Background and verified payload shapes: [`docs/whatsapp-bsuid-usernames.md`](../docs/whatsapp-bsuid-usernames.md).

## Why now

- BSUID appears in webhooks since **April 2026**; send-to-BSUID shipped **July 2026**;
  support is **mandatory** as of now.
- The current phone-centric model has a **live-drop risk**: the webhook Zod schema
  marks `from` as required, so a username-only inbound returns 400 and never
  reaches Convex.

## Current State (phone-centric)

- Inbound parsing: [`src/app/api/webhook/route.ts`](../src/app/api/webhook/route.ts)
  - `webhookMessageSchema.from` is **required**.
  - `contacts[].wa_id` is **required**; no `user_id` / `username` fields.
  - `statuses[]` has no `recipient_user_id`.
- Ingest: [`convex/gateway.ts`](../convex/gateway.ts) (`webhookIngest`,
  `webhookStatusUpdate`, `resolveRecipient`) and
  [`convex/webhook.ts`](../convex/webhook.ts) resolve everything by phone.
- Storage: [`convex/schema.ts`](../convex/schema.ts) `contacts` requires
  `waId` and `phone`; [`convex/contacts.ts`](../convex/contacts.ts) `upsert`
  keys on phone.
- Sending: [`convex/whatsapp.ts`](../convex/whatsapp.ts) hardcodes
  `to: <E.164>` in every send action.
- MCP: [`src/lib/mcp-server.ts`](../src/lib/mcp-server.ts) documents recipients as
  "phone (E.164)".
- Dashboard: [`ConversationList`](../src/components/ConversationList.tsx) /
  [`MessageThread`](../src/components/MessageThread.tsx) render the phone number.

## Design principles

1. **Phone is an attribute, not a key.** The primary routing identity is an
   opaque `userId` (BSUID); phone is optional and backfilled when Meta shares it.
2. **Fail open on parsing.** Loosen inbound validation so unknown/absent phone
   fields never drop a message; prefer `passthrough()` + optional fields.
3. **Precedence matches Meta.** When both phone and BSUID are known, send by phone
   (`to`) — Meta ignores `recipient` if `to` is present.
4. **Channel-neutral where cheap.** Name new fields generically enough that
   Telegram's `chat_id` reuses them (`userId`, not `bsuid`).

## Phases

### Phase 0 — Branch & guardrails
- Create branch `feat/whatsapp-bsuid-support` off `main` (do **not** stack on the
  in-flight `feat/whatsapp-calling-control-plane`).
- Confirm access to Meta's BSUID **dummy webhook API** for testing.
- Capture a real/dummy BSUID payload fixture under a test dir for regression.

### Phase 1 — Stop dropping username-only inbound (highest priority, ships alone)
File: [`src/app/api/webhook/route.ts`](../src/app/api/webhook/route.ts)
- `webhookMessageSchema`: make `from` **optional**; add optional `from_user_id`,
  `from_parent_user_id`.
- Contacts block in `webhookValueSchema`: make `wa_id` **optional**; add optional
  `profile.username`, `user_id`, `parent_user_id`.
- `webhookStatusSchema`: add optional `recipient_user_id`, `recipient_parent_user_id`
  (`recipient_id` already optional).
- Forward `from_user_id` and the contact `user_id`/`username` through to the
  gateway calls (today only phone-derived data is passed).
- **Acceptance:** a username-only dummy payload returns 200 and produces a stored
  message. Commit this on its own — it's the live-risk fix.

### Phase 2 — Storage: phone-optional contacts
File: [`convex/schema.ts`](../convex/schema.ts) `contacts`
- Add `userId?: string` (BSUID), `parentUserId?: string`, `username?: string`.
- Make `waId?` and `phone?` optional (backward compatible — existing rows keep
  their strings).
- Add index `by_account_user_id: ["accountId", "userId"]`.
- **Migration note:** no data backfill required; optional validators accept
  existing populated rows. New rows may omit phone.

### Phase 3 — Contact resolution & ingest
Files: [`convex/contacts.ts`](../convex/contacts.ts), [`convex/webhook.ts`](../convex/webhook.ts)
- Rewrite `upsert` resolution order:
  1. by `userId` (BSUID) when present → update, backfill phone if newly shared.
  2. else by phone/`waId` → update, backfill `userId`.
  3. else create.
- Handle the `system` number-change message: re-map an existing contact's BSUID
  (dedupe by prior identifier) instead of creating a duplicate.
- Store `username` for display.
- **Acceptance:** the same user seen first as username-only, then later with a
  shared phone, resolves to **one** contact.

### Phase 4 — Sending to BSUID
Files: [`convex/metaFetch.ts`](../convex/metaFetch.ts) (or shared util),
[`convex/whatsapp.ts`](../convex/whatsapp.ts), [`convex/gateway.ts`](../convex/gateway.ts)
- Add `isBsuid()` helper: `/^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]+$/`.
- In each send action (`sendTextMessage`, `sendMediaMessage`,
  `sendTemplateMessage`, `sendReaction`): build the recipient field as
  `{ recipient: to }` when `isBsuid(to)`, else `{ to }`.
- `resolveRecipient` in the gateway: accept a phone **or** a BSUID; when a stored
  contact has only `userId`, send by BSUID.
- **Acceptance:** replying to a username-only contact succeeds via `recipient`.

### Phase 5 — MCP surface wording
File: [`src/lib/mcp-server.ts`](../src/lib/mcp-server.ts)
- Reword recipient params from "phone (E.164)" to "recipient — phone number or
  WhatsApp user ID (BSUID)".
- Ensure disclosure/listing responses (`listContactsForAccount`) surface
  `username`/`name` when phone is absent so agents can address contacts.

### Phase 6 — Dashboard display
Files: [`ConversationList`](../src/components/ConversationList.tsx),
[`MessageThread`](../src/components/MessageThread.tsx)
- Display fallback chain: `name` → `@username` → phone → BSUID (truncated).
- Never render an empty/blank identity for username-only contacts.

### Phase 7 — Docs & verification
- Update Fumadocs content if any user-facing wording implies phone-only
  (`content/docs/mcp-tools.mdx`, `content/docs/whatsapp-setup.mdx`).
- `pnpm run typecheck` and `pnpm run check:write`.
- Manual: run all dummy BSUID payload types (message, delivered/read status,
  failed status w/o contacts, number-change system message) through the webhook.

## Out of scope (tracked, not silently dropped)

- **Templates / 24h window semantics** for BSUID-only contacts with no prior phone
  interaction — confirm messaging-window rules before relying on free-form sends.
- **"Phone Number Request" button** flow (WhatsApp's share-your-number prompt).
  Nice-to-have; not required for compliance.
- **Telegram channel** itself — this plan only makes the identity model
  Telegram-ready. See the separate Telegram integration research.

## Rollout / risk

- Phase 1 is the only piece with live-drop risk and is independently shippable —
  land and deploy it first.
- Phases 2–4 are a coordinated schema + ingest + send change; deploy together.
- Backward compatible throughout: legacy phone-only contacts and sends keep
  working (phone takes precedence per Meta).

## Definition of done

- Username-only inbound messages are ingested (not dropped).
- Contacts persist and de-duplicate on BSUID; phone backfills when shared.
- Outbound replies succeed to BSUID-only contacts.
- MCP + dashboard render and address contacts without a phone number.
- `typecheck` + Biome clean; dummy-API payloads verified end to end.
