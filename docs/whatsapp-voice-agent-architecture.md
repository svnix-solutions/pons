# WhatsApp Voice Agent Architecture (Meta <-> Pons <-> Dograh)

This document is the internal reference for adding WhatsApp voice calling to Pons
and connecting each call to a self-hosted conversational voice agent (Dograh).

It covers:
- The three planes: control (Pons), media (Asterisk/Dograh), and MCP
- Which Meta Graph API endpoints and webhook fields are involved
- How call audio reaches the voice agent without touching Convex
- How the Pons MCP server both drives calls and is called by the agent mid-call
- Eligibility gates and the known unknowns to validate first

This is repository docs (not Fumadocs content). It describes a design that is
**not yet implemented** — see the phased plan in
`.plans/2026-08-19-whatsapp-voice-agent.md`.

## Architecture Overview

Three separate planes. Keep them mentally distinct — the most common design error
is assuming MCP or the Graph API carries audio. It does not.

```
WhatsApp user (voice)
        │  SIP + SRTP (OPUS)                         ── MEDIA PLANE ──
        ▼
   Asterisk / Kamailio  ──ARI──▶  Dograh (Pipecat)  ──API──▶  BYO STT/LLM/TTS
   (SIP B2BUA, media)                │
        ▲                           │ session events
        │ Graph API (JSON)          │                ── CONTROL PLANE ──
   WhatsApp Calling API             ▼
   (consent / POST /calls / ─────▶ PONS (Convex + Next.js)
    calls webhook)                 • call control + lifecycle DB
                                   • MCP tools (drive calls)        ── MCP PLANE ──
                                   • correlate waCallId ↔ session
                                   • messaging tools (agent acts mid-call)
```

1. **Control plane (Pons)** — request consent, initiate/terminate calls, ingest
   the `calls` webhook, store lifecycle. All HTTPS/JSON via the existing
   `metaFetch` and signature-verify path.
2. **Media plane (Asterisk + Dograh)** — terminates Meta's SIP+SRTP audio and
   runs the voice agent. Lives entirely outside Convex; Convex actions are
   short-lived and cannot hold RTP/WebSocket audio.
3. **MCP plane** — exposes calling as MCP tools (Direction A) and lets the Dograh
   agent call Pons messaging tools during a call (Direction B). Control/data
   only, never audio.

## Why a media bridge is required

Dograh does not speak WhatsApp call media natively. WhatsApp Business Calling
emits WebRTC (ICE+DTLS+SRTP) or SIP (SIP+SDES SRTP), codecs OPUS/PCMU/PCMA.
Dograh ingests audio over WebSocket streaming or Asterisk ARI / custom SIP.

Because Meta offers a SIP mode and Dograh supports Asterisk ARI, bridging over
SIP/RTP is the low-code path: Asterisk terminates Meta's SIP+SRTP and hands the
call to Dograh via ARI. This avoids writing and operating a custom WebRTC/SDP
terminator. A self-hosted WebRTC terminator feeding Dograh's WebSocket transport
is the fallback, used only if SIP mode cannot be enabled on the number.

## Meta Graph API Endpoints and Webhook Fields

Calling adds a new endpoint and a new webhook field alongside messaging:

1. Business-initiated call (per phone number)
   - `POST /{phone-number-id}/calls`
   - `action: "connect"` with an SDP session; also used to terminate.
   - Requires prior user consent (a Call Permission Request message).

2. Call events webhook (per WABA)
   - Arrives on `change.field === "calls"` (not `"messages"`).
   - Lifecycle: `ringing`, `accepted`, `rejected`, `terminated`, plus the
     consent-grant event.

Consent model: after the user accepts a Call Permission Request, the business may
place up to 5 calls / 24h for a 7-day window.

## Source of Truth in Code

Existing (reused):
- Meta API helper:
  - `convex/metaFetch.ts`
- Messaging actions (pattern to mirror for calls):
  - `convex/whatsapp.ts`
- Webhook endpoint and parsing:
  - `src/app/api/webhook/route.ts`
- Webhook signature verification + ingest gateway:
  - `convex/gateway.ts`
  - `convex/mcpNode.ts`
- Webhook processing + status ingest:
  - `convex/webhook.ts`
- MCP tool groups, scope checks, dispatch:
  - `convex/gateway.ts` (`READ_TOOLS` / `SEND_TOOLS` / `WRITE_TOOLS`,
    `assertMcpToolPermissions`, `runMcpTool`)
- MCP scopes + API key auth:
  - `convex/mcp.ts` (`VALID_SCOPES`, `validateApiKeyInternal`)

New (to be added):
- Call control actions:
  - `convex/whatsappCalls.ts` (`requestCallPermission`, `initiateCall`,
    `terminateCall`)
- Call schema:
  - `convex/schema.ts` (`calls` table)
- Call webhook ingest:
  - `convex/gateway.ts` (`webhookCallEvent`)
  - `convex/webhook.ts` (`ingestCallEvent`)

## Known Gate in the Webhook Route

`src/app/api/webhook/route.ts` currently drops every change whose
`field !== "messages"`. Call events arrive on the `calls` field and are discarded
today. Enabling calling requires:
- widening that gate to also accept `change.field === "calls"`, and
- extending `webhookValueSchema` with a `calls` array.

## MCP Integration

The Pons MCP server is a scoped tool-dispatch layer, so calling integrates in two
directions without touching messaging behavior.

### Direction A — MCP drives calls

An MCP client (Claude, an automation, a campaign runner) places and manages calls.

- New scopes in `convex/mcp.ts` (`VALID_SCOPES`): `calls:read`, `calls:write`.
- New `CALL_TOOLS` group in `convex/gateway.ts`:
  `request_call_permission`, `start_call`, `end_call`, `get_call`, `list_calls`.
- New `calls:*` branch in `assertMcpToolPermissions` and new `case` arms in
  `runMcpTool` delegating to `convex/whatsappCalls.ts`.

### Direction B — the agent acts mid-call

Dograh, configured as an MCP client of Pons with a narrowly scoped API key, calls
existing messaging tools during a live call:
- `send_text`, `send_template`, `send_media`, `get_conversation`.

This closes the omnichannel loop — voice and chat land on the same contact and
Pons record. Scope the Dograh key to messaging only (e.g. `send`,
`conversations:read`) and **not** `calls:write`, so the in-call agent can message
but cannot spawn new outbound calls.

Dependency to verify: Dograh must support calling an external MCP server as a tool
at conversation time (runtime tool-calling), not just the build-time coding-agent
MCP.

## Correlation Model

Each call is one row in the `calls` table linking the two systems:
- `waCallId` — Meta's call identifier (from `POST /calls` and the `calls`
  webhook).
- `dograhSessionId` — the voice-agent session, persisted back after the media
  bridge connects.

This lets Pons surface transcript/recording links on the conversation timeline
and reconcile lifecycle events with the agent session.

## Eligibility Gates (validate before building)

- Region is not on the exclusion list (as of mid-2025: US, Canada, Turkey, Egypt,
  Vietnam, Nigeria).
- The WABA phone number can be Calling-enabled and is at 1K+ messaging tier.
- The business-initiated-over-SIP handshake works end-to-end (inbound SIP INVITE
  is well-trodden; business-initiated over SIP is the primary unknown).
- Codec path: Meta OPUS/PCMU/PCMA transcodes acceptably to the chosen STT /
  speech-to-speech input; measure the Asterisk transcode latency hop.
- Dograh runtime MCP-tool support (Direction B).

## Debugging Notes

- **Call events never arrive**: confirm the webhook route accepts
  `field === "calls"`; the default gate silently drops them.
- **Consent errors on initiate**: the user has not granted permission, or the
  5-call / 7-day window is exhausted; surface Meta subcodes via
  `formatMetaError`.
- **Call connects but no audio / one-way audio**: codec/transcoding mismatch at
  Asterisk (OPUS vs PCMU/PCMA vs provider input).
- **Number rejects calls**: number is not Calling-enabled, below tier, or in an
  excluded region.
- **Agent cannot send WhatsApp mid-call**: Dograh MCP key lacks the messaging
  scope, or Dograh is not configured to call the external MCP at runtime.

## Related Documents

- Phased implementation plan: `.plans/2026-08-19-whatsapp-voice-agent.md`
- Registration/webhook lifecycle: `docs/whatsapp-meta-registration-deregistration.md`
</content>
