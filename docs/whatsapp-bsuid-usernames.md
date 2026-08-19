# WhatsApp Usernames & Business-Scoped User IDs (BSUID)

This document is the internal reference for how Pons must handle WhatsApp
usernames and the associated **Business-Scoped User ID (BSUID)** identifier.

It covers:
- What BSUID is and why supporting it is mandatory
- The exact webhook payload shapes (verified against Meta's reference)
- How BSUID changes our phone-centric identity model
- How this same generalization unblocks a future Telegram channel

This is repository docs (not Fumadocs content).

Companion implementation plan: [`.plans/2026-08-19-whatsapp-bsuid-support.md`](../.plans/2026-08-19-whatsapp-bsuid-support.md).

## Why this matters (and why it's urgent)

Meta introduced **usernames** so WhatsApp users can contact businesses without
exposing a phone number. To support that on the Business Platform, Meta added
the **Business-Scoped User ID (BSUID)** — an opaque, business-scoped identifier
that appears alongside (and sometimes *instead of*) the phone number.

Timeline:
- **Early April 2026** — BSUID began appearing in webhooks.
- **July 2026** — the "Send to BSUID" API went live.
- **Now** — supporting BSUID is **required for all partners and directly-integrated
  businesses**. Meta's guidance: workflows that depend on phone numbers "risk
  disruption once users with a username start sending messages."

Pons is currently phone-centric end to end (`contacts.waId`/`phone`, gateway
recipient resolution by phone, `to: <E.164>` in every send). That means:
- **A username-only inbound message can be silently dropped today** — see the
  webhook parser risk below.
- **We cannot reply to a username-only contact** — we have no phone to send to.

## What a BSUID is

- **Format:** `<ISO-3166 alpha-2>.<up to 128 alphanumerics>`, e.g.
  `US.13491208655302741918`.
- **Parent BSUID:** for businesses with multiple enrolled portfolios, a shared
  identifier with an `ENT` segment, e.g. `US.ENT.11815799212886844830`. Usable by
  any business phone number within the enrolled portfolio set.
- **Scope:** unique per **user × business**. Not a global user ID.
- **Not permanent:** the BSUID **regenerates when the user changes phone number**,
  which fires a `system` message webhook. It is stable *within a relationship*
  while the phone stays constant, but our storage must be able to re-map it.
- **Always present going forward:** `user_id`/`from_user_id` are included in
  message and status webhooks regardless of username adoption. The phone
  (`wa_id`/`from`/`recipient_id`) is now the *conditional* field.

### When the phone number is omitted

Meta includes the phone number only if **at least one** holds:
- you interacted with the user within the last **30 days**, or
- the user is in your business **Contact Book**, or
- the user has **not** adopted a username.

Otherwise `wa_id` / `from` / `recipient_id` are absent and only the BSUID is given.

## Verified webhook payload shapes

Source: [Meta — Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/).

### Inbound message (username user)

```jsonc
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
        "contacts": [{
          "profile": { "name": "...", "username": "<USERNAME>" },  // username: new, optional
          "wa_id": "<PHONE>",                 // CONDITIONAL — omitted when username-only
          "user_id": "<BSUID>",               // ALWAYS present
          "parent_user_id": "<PARENT_BSUID>"  // only with multi-portfolio
        }],
        "messages": [{
          "from": "<PHONE>",                  // CONDITIONAL — omitted when username-only
          "from_user_id": "<BSUID>",          // ALWAYS present
          "from_parent_user_id": "<PARENT_BSUID>",
          "id": "wamid...",
          "timestamp": "...",
          "type": "text",
          "text": { "body": "..." }
        }]
      }
    }]
  }]
}
```

### Status webhook

```jsonc
"statuses": [{
  "id": "wamid...",
  "status": "delivered",
  "timestamp": "...",
  "recipient_id": "<PHONE>",              // CONDITIONAL — omitted when sent to BSUID w/o phone
  "recipient_user_id": "<BSUID>",         // ALWAYS present for sent/delivered/read
  "recipient_parent_user_id": "<PARENT_BSUID>"
}]
```

Notes:
- On `failed` statuses the `contacts` array is **omitted entirely**.
- `contacts[].user_id` mirrors the recipient BSUID.

### Sending to a BSUID

`recipient` replaces `to`. If both are provided, **`to` (phone) takes precedence**.

```jsonc
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "recipient": "<BSUID>",   // or "<PARENT_BSUID>"; omit `to`
  "type": "text",
  "text": { "body": "..." }
}
```

There is also a **"Phone Number Request"** message/button that asks the customer
to share their number, which WhatsApp then auto-adds to the business Contact Book.
(This is the WhatsApp analogue of Telegram's `request_contact` share-your-number
flow.)

## Impact on the Pons identity model

The core change is: **phone is no longer the primary key for a contact.**

| Concept | Today | After BSUID |
|---|---|---|
| Contact routing key | `phone` / `waId` (E.164) | `userId` (BSUID), phone optional |
| Inbound sender | `from` (phone) | `from_user_id` (BSUID), `from` optional |
| Outbound address | `to: <phone>` | `recipient: <BSUID>` when no phone |
| Status recipient | `recipient_id` (phone) | `recipient_user_id` (BSUID) |

BSUID detection (no leading `+`, contains a `.`):

```ts
export const isBsuid = (s: string) => /^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]+$/.test(s);
```

Contact resolution order becomes:
1. Look up by `userId` (BSUID) when present.
2. Else look up by phone (`waId`) — legacy contacts.
3. Else create a new contact.
4. On a `system` number-change message, **re-map** the existing contact's BSUID
   (dedupe by the prior identifier) rather than creating a duplicate.

The key rule everywhere: **never require phone; treat it as an attribute to
backfill.**

## Source-of-truth in code

- Webhook parser (the live-drop risk lives here):
  - [`src/app/api/webhook/route.ts`](../src/app/api/webhook/route.ts) —
    `from` is currently a **required** field; a username-only payload fails
    validation and returns 400 before reaching Convex.
- Webhook signature + ingest gateway:
  - [`convex/gateway.ts`](../convex/gateway.ts) — `webhookIngest`,
    `webhookStatusUpdate`, and `resolveRecipient` (phone-only today).
- Ingest mutations:
  - [`convex/webhook.ts`](../convex/webhook.ts)
- Contact storage:
  - [`convex/schema.ts`](../convex/schema.ts) — `contacts` table
  - [`convex/contacts.ts`](../convex/contacts.ts) — `upsert`
- Send actions (hardcode `to: <phone>`):
  - [`convex/whatsapp.ts`](../convex/whatsapp.ts)
  - [`convex/metaFetch.ts`](../convex/metaFetch.ts) — shared Graph helper
- MCP tool surface & descriptions:
  - [`src/lib/mcp-server.ts`](../src/lib/mcp-server.ts) — "phone (E.164)" wording
- Dashboard rendering (assumes phone):
  - [`src/components/ConversationList.tsx`](../src/components/ConversationList.tsx),
    [`src/components/MessageThread.tsx`](../src/components/MessageThread.tsx)

## Relationship to a future Telegram channel

Telegram bots address users by numeric `chat_id`, **never** by phone (a bot only
learns a phone if the user explicitly shares it). This is the *same* problem
BSUID creates for WhatsApp: an opaque routing ID with an optional phone.

Designing `contacts` around an opaque `userId` + optional `phone` satisfies BSUID
compliance **and** provides the identity model Telegram needs — so the BSUID work
should land first and be built channel-neutral where practical.

## Testing

Meta exposes **dummy APIs on the existing webhook endpoint** so partners can
simulate BSUID payloads without a real username user. Use these to validate the
loosened Zod schema and the contact-resolution path before rollout. A community
"BSUID Transition Checker" webhook simulator also exists (Dualhook) for spot
checks.

## References

- [Meta — Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/)
- [Meta — Send messages (Cloud API)](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/)
- [WABetaInfo — username updates for business partners](https://wabetainfo.com/whatsapp-shares-new-username-updates-with-business-partners/)
- [Infobip — WhatsApp usernames and user IDs](https://www.infobip.com/docs/whatsapp/manage-integration/usernames-and-user-ids)
- [Chatwoot — BSUID support tracking issue](https://github.com/chatwoot/chatwoot/issues/13837)
- [Vonage — Understanding WhatsApp Usernames and BSUIDs](https://api.support.vonage.com/hc/en-us/articles/26938046521116-Understanding-WhatsApp-Usernames-and-Business-Scoped-User-IDs-BSUIDs-Required-Actions-and-Changes)
