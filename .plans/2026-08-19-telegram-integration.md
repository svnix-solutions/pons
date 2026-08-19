# Telegram Bot Integration Plan

## Goal

Add **Telegram** as a second messaging channel alongside WhatsApp, exposing the
same MCP tool surface (`list_conversations`, `send_text`, `send_media`,
`send_reaction`, …) so AI agents interact with Telegram chats exactly as they do
with WhatsApp.

A Pons "Telegram account" is a **bot** (token from @BotFather). Inbound updates
arrive by webhook; outbound messages go to `api.telegram.org`. Conversations,
messages, contacts, media storage, outbound event forwarding, and the real-time
dashboard are **reused**, not duplicated.

## Dependency

This plan assumes the **BSUID identity generalization** has landed first
(see [`.plans/2026-08-19-whatsapp-bsuid-support.md`](2026-08-19-whatsapp-bsuid-support.md)),
because both channels need the same thing: an opaque `userId` routing key with
phone as an optional attribute. Telegram addresses users by numeric `chat_id`
and a bot only learns a phone if the user explicitly shares it — so a
phone-centric model cannot work for Telegram at all.

If BSUID work slips, Phase 1 here must do the minimal identity generalization
itself.

## Why Telegram is simpler than WhatsApp (per channel)

- **Onboarding is one step:** paste a bot token, call `setWebhook`. No WABA
  discovery, phone provisioning, OTP, display-name review, or Twilio number
  purchase. The largest WhatsApp modules
  ([`whatsappDiscovery.ts`](../convex/whatsappDiscovery.ts),
  [`phoneRegistration.ts`](../convex/phoneRegistration.ts),
  [`nameReview.ts`](../convex/nameReview.ts),
  [`twilioConnect.ts`](../convex/twilioConnect.ts)) have **no Telegram analogue**.
- **No templates, no 24-hour window.** Telegram has no pre-approval and no
  customer-service window. `send_template` / `list_templates` / `windowExpiresAt`
  are N/A.
- **No media-URL expiry pressure.** Telegram `file_id`s are stable (still
  downloaded via `getFile`, but without WhatsApp's 5-minute deadline).

## Where Telegram differs (design constraints)

- **Identity is `chat_id` (integer), not phone.** The only always-present,
  sendable identifier. Store it as the contact `userId`. Phone is optional and
  only present if the user shares it via a `request_contact` button.
- **No cold outreach.** A bot can only message users who have `/start`ed it (or
  share a group). There is no "message a new number/handle first." (True cold
  outreach needs an MTProto/TDLib **user account**, which is a different,
  ToS-sensitive integration — explicitly out of scope.)
- **No delivery/read receipts.** Bots don't learn when a sent message is
  delivered or read. The message `status` machine collapses to `sent` | `failed`;
  there is no Telegram equivalent of `webhookStatusUpdate`.
- **No calls.** The Bot API has no voice calls. The WhatsApp calling work
  ([`whatsappCalls.ts`](../convex/whatsappCalls.ts), [`calls.ts`](../convex/calls.ts))
  has no Telegram path.
- **Webhook security differs.** No HMAC. Telegram uses a `secret_token` set on
  `setWebhook`, echoed in the `X-Telegram-Bot-Api-Secret-Token` request header
  (plus a hard-to-guess secret path in the URL). Constant-time compare, not HMAC.
- **`message_id` is per-chat, not global.** Unique only within a chat, so
  reply/reaction lookups key on `(chat_id, message_id)`, not a global id like
  WhatsApp's `wamid`.
- **Reactions:** `setMessageReaction` (Bot API 7.0+) maps to `send_reaction`.

## Implementation strategy

Two options were considered:

- **Path A — parallel vertical:** add `convex/telegram.ts` + a Telegram webhook
  route + a `platform` discriminator on accounts; the gateway branches on
  `account.platform`. Fastest to a working bot; some duplication.
- **Path B — channel abstraction:** a provider interface (`send`,
  `downloadMedia`, `verifyWebhook`, `parseInbound`) with a fully generic schema.
  Cleaner for a 3rd channel; larger refactor.

**Chosen: Path A, built to converge on B.** Reuse the shared internal mutations
(contacts/conversations/messages, forwarding, storage) rather than copying them;
keep provider-specific logic isolated in `telegram.ts`. This ships a channel
quickly while the seams naturally harden into an abstraction later.

## Current state (what already generalizes)

- **MCP tool names** in [`src/lib/mcp-server.ts`](../src/lib/mcp-server.ts) and the
  dispatch in [`convex/gateway.ts`](../convex/gateway.ts) are already
  platform-neutral. The recipient resolution (`resolveFrom` / `resolveRecipient`)
  is phone-coupled and needs a channel-aware path.
- **Storage / forwarding / dashboard** are channel-agnostic and reusable as-is.
- **Send actions** in [`convex/whatsapp.ts`](../convex/whatsapp.ts) are
  Meta-specific and are mirrored (not shared) by a new `telegram.ts`.

## Phases

### Phase 0 — Branch & scaffolding
- Branch `feat/telegram-integration` off `main`.
- Add `TELEGRAM_WEBHOOK_SECRET` handling to env schema
  ([`src/env.js`](../src/env.js)); bot tokens are stored per-account in Convex
  (never in env), mirroring how WhatsApp credentials are stored.

### Phase 1 — Account model: `platform` discriminator
File: [`convex/schema.ts`](../convex/schema.ts)
- Add `platform: "whatsapp" | "telegram"` to `accounts` (default `"whatsapp"` for
  existing rows via optional + backfill).
- Add Telegram-specific account fields (all optional): `telegramBotToken`
  (treated as a secret; mask in UI to last 4), `telegramBotId`,
  `telegramBotUsername`, `telegramWebhookSecret`.
- Make WhatsApp-only account fields (`wabaId`, `phoneNumberId`, name-review, etc.)
  tolerate absence for Telegram accounts (they already are largely optional).
- **Acceptance:** a Telegram account can exist with only a bot token + bot
  identity, no WABA/phone.

### Phase 2 — Contact identity for Telegram
Files: [`convex/schema.ts`](../convex/schema.ts), [`convex/contacts.ts`](../convex/contacts.ts)
- Reuse the channel-neutral `contacts.userId` (from BSUID work) to store the
  Telegram `chat_id`; `username`/`phone`/`name` optional.
- Ensure `upsert` resolves by `userId` (chat_id) and never requires phone.
- **Acceptance:** an inbound Telegram message creates/looks-up one contact keyed
  on chat_id.

### Phase 3 — Inbound webhook
File: `src/app/api/telegram/webhook/[secret]/route.ts` (new)
- `POST` handler: verify the `X-Telegram-Bot-Api-Secret-Token` header (constant
  time) **and** the secret path segment; resolve the account by bot id.
- Parse the Telegram `Update` object (message, edited_message,
  callback_query, message_reaction) — Zod schema, lenient/`passthrough`.
- Map to internal ingest: contact upsert (chat_id), conversation upsert, message
  store, media download-and-store (`getFile` → file path → Convex storage).
- Emit the same outbound forwarding events
  ([`convex/forwarding.ts`](../convex/forwarding.ts)) as WhatsApp
  (`message.inbound.received`, etc.).
- **Acceptance:** sending a message to the bot appears in the dashboard in
  real time.

### Phase 4 — Send actions
File: `convex/telegram.ts` (new), mirroring [`convex/whatsapp.ts`](../convex/whatsapp.ts)
- Internal actions: `sendTextMessage`, `sendMediaMessage`, `sendReaction`
  against `https://api.telegram.org/bot<token>/<method>` (`sendMessage`,
  `sendPhoto`/`sendDocument`/`sendVideo`/`sendAudio`, `setMessageReaction`).
- Token from the account record (Authorization not used by Telegram; token is in
  the URL path per Bot API — keep it out of logs).
- Record messages with `status: "sent"` (no delivered/read); mark `failed` on
  API error. Store the returned per-chat `message_id`.
- `sendTemplate` / `list_templates`: return a clear "not supported on Telegram"
  result.
- **Acceptance:** `send_text` / `send_media` / `send_reaction` via MCP reach a
  Telegram chat.

### Phase 5 — Gateway channel routing
File: [`convex/gateway.ts`](../convex/gateway.ts)
- `resolveFrom`: resolve the account and read `account.platform`.
- Dispatch send tools to `internal.telegram.*` when `platform === "telegram"`,
  else `internal.whatsapp.*`.
- `resolveRecipient`: accept a chat_id / @username / phone and resolve to a stored
  contact; for Telegram, sending requires chat_id.
- Return "unsupported on this channel" for `send_template` / `list_templates` when
  Telegram.
- **Acceptance:** the same MCP tool call works against a Telegram account by
  passing `from = <bot number/handle>`.

### Phase 6 — Onboarding UI
Files: [`src/components/SetupAccount.tsx`](../src/components/SetupAccount.tsx) (or a new Telegram setup component), dashboard
- "Add Telegram bot" flow: paste bot token → server calls `getMe` (validate +
  fetch bot id/username) → generate `telegramWebhookSecret` → call `setWebhook`
  with the secret URL + `secret_token`.
- Show connection status; allow token rotation and `deleteWebhook` on detach.
- **Acceptance:** a user connects a bot end to end from the dashboard with no CLI.

### Phase 7 — Dashboard & docs
- Channel badge on conversations/accounts; identity display falls back
  `name → @username → chat_id` (no phone assumption).
- Fumadocs: add a Telegram setup page; update
  [`content/docs/mcp-tools.mdx`](../content/docs/mcp-tools.mdx) to note channel
  differences (no templates/status/calls on Telegram).
- `pnpm run typecheck` + `pnpm run check:write`.

## Out of scope

- **Cold outreach / MTProto user accounts** (ToS-sensitive; bots can't do it).
- **Voice calls** (no Bot API support).
- **Templates / message windows** (Telegram has neither).
- **Delivery/read receipts** (bots don't receive them).
- **Group/channel management** beyond basic message send/receive (can follow
  later).

## Rollout / risk

- Fully additive: no change to WhatsApp behavior. `platform` defaults to
  `whatsapp`; existing accounts and flows are untouched.
- Bot token is a secret — store in Convex only, mask in UI (last 4), never log.
- Webhook secret path + `secret_token` header must both be verified; reject
  otherwise. No signature means the secret is the only gate — treat it as such.
- Ship behind the channel discriminator so Telegram can be enabled per
  deployment/account.

## Definition of done

- A user connects a Telegram bot from the dashboard (paste token → auto webhook).
- Inbound Telegram messages (text + media) appear in real time and forward events.
- MCP `send_text` / `send_media` / `send_reaction` work against a Telegram account.
- Unsupported tools (`send_template`, calls) return clear, non-error guidance.
- No regression to WhatsApp; `typecheck` + Biome clean.
