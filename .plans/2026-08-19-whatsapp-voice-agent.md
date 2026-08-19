# WhatsApp Voice Agent Plan

## Goal

Add WhatsApp voice calling to Pons and connect each call to a self-hosted
conversational voice agent (Dograh), controllable through the Pons MCP server.

Three capabilities, delivered in order:

1. **Calling control plane** — Pons can request call consent, initiate/terminate
   WhatsApp Business calls, and record call lifecycle, reusing the existing Meta
   Graph + webhook infrastructure.
2. **Self-hosted media** — call audio is bridged into a self-hosted Dograh voice
   agent (Pipecat STT/LLM/TTS or speech-to-speech) via SIP/Asterisk.
3. **MCP integration** — calling is exposed as MCP tools (agent *drives* calls),
   and the in-call Dograh agent can call back into Pons MCP messaging tools
   (agent *acts* on WhatsApp mid-call).

Messaging behavior, auth, and the MCP tool model stay intact. This is additive.

## Current State

### Messaging + Meta integration

- All Meta Graph calls go through one typed helper,
  [metaFetch()](convex/metaFetch.ts) (Bearer auth, structured error handling,
  `v22.0` base URL).
- Outbound messaging actions live in [whatsapp.ts](convex/whatsapp.ts)
  (`sendTextMessage`, `sendMediaMessage`, `sendTemplateMessage`, `sendReaction`),
  each resolving a Facebook OAuth token via `resolveAccessToken`.
- Inbound webhooks enter at [route.ts](src/app/api/webhook/route.ts), are
  signature-verified inside Convex via [gateway.ts](convex/gateway.ts)
  (`webhookIngest`, `webhookStatusUpdate`), and processed in
  [webhook.ts](convex/webhook.ts) (`ingestWebhook`, `processWebhookLog`,
  `ingestStatusUpdate`).
- Domain events fan out through `forwarding.enqueueEvent`.

### Known gate in the webhook route

- [route.ts](src/app/api/webhook/route.ts) drops every change whose
  `field !== "messages"`. Call events arrive on a different field (`calls`) and
  are discarded today.

### MCP surface

- Tool groups are declared in [gateway.ts](convex/gateway.ts) (`READ_TOOLS`,
  `SEND_TOOLS`, `WRITE_TOOLS`), permission-gated in `assertMcpToolPermissions`,
  and dispatched in the `runMcpTool` switch.
- Scopes are allow-listed in [mcp.ts](convex/mcp.ts) (`VALID_SCOPES`); API keys
  are per-user and scoped (`validateApiKeyInternal`).

### Not present today

- No calling, SIP, WebRTC, or media handling anywhere.
- No voice-AI / STT / TTS / speech-to-speech integration.
- Adding a voice agent is greenfield; the natural seams are `whatsapp.ts`,
  `webhook.ts` / `route.ts`, `metaFetch.ts`, `gateway.ts`, and `mcp.ts`.

## Reference Direction

Architectural facts driving this plan (from prior research):

- **WhatsApp Business Calling API** supports business-initiated VoIP calls after
  explicit user consent (Call Permission Request), then up to 5 calls / 24h for a
  7-day window. Media options: WebRTC (ICE+DTLS+SRTP) or **SIP (SIP+SDES SRTP)**,
  codecs OPUS / PCMU / PCMA.
- **Regional exclusions** (as of mid-2025): US, Canada, Turkey, Egypt, Vietnam,
  Nigeria. Number must be Calling-enabled, at 1K+ messaging tier.
- **Dograh** is an open-source, self-hostable voice agent (Pipecat-based). It
  ingests audio over WebSocket streaming or **Asterisk ARI / custom SIP**, is
  BYO-provider for STT/LLM/TTS, and is marketed MCP-native.

Key implication: Dograh does **not** speak WhatsApp call media natively. Because
Meta offers a SIP mode and Dograh supports Asterisk ARI, bridging them over
SIP/RTP avoids writing a custom WebRTC/SDP terminator.

## Target Architecture

Pons is the **control plane**; Asterisk is the **media gateway**; Dograh is the
**agent**. MCP ties them together for AI-driven operation.

```
WhatsApp user (voice)
        │  SIP + SRTP (OPUS)
        ▼
   Asterisk / Kamailio  ──ARI──▶  Dograh (Pipecat)  ──API──▶  BYO STT/LLM/TTS
   (SIP B2BUA, media)                │
        ▲                           │ session events
        │ Graph API                 │
   WhatsApp Calling API             ▼
   (consent / POST /calls / ─────▶ PONS (Convex + Next.js)
    calls webhook)                 • call control + lifecycle DB
                                   • MCP tools (drive calls)
                                   • correlate waCallId ↔ Dograh session
                                   • messaging tools (agent acts mid-call)
```

### Control plane (Pons)

- Consent messages, `POST /{phoneNumberId}/calls`, call termination, and the
  `calls` webhook, all via `metaFetch` and the existing signature-verify path.
- A `calls` table holds lifecycle state plus the Dograh session id for
  correlation.

### Media plane (outside Convex)

- Asterisk/Kamailio terminates Meta's SIP+SRTP, transcodes OPUS if needed, and
  presents the call to Dograh via ARI. Convex actions are short-lived and never
  hold RTP/WebSocket audio.

### MCP plane

- **Direction A** — MCP client drives calls via new `calls:*` tools.
- **Direction B** — Dograh, as an MCP client of Pons, calls existing messaging
  tools (`send_text`, `send_template`, `send_media`, `get_conversation`) during a
  live call. MCP is control/data only — it never carries audio.

## Design Principles

- Additive only: do not change messaging, auth, or existing MCP tool behavior.
- Reuse `metaFetch`, the webhook signature-verify path, and the forwarding bus.
- Keep the media plane entirely outside Convex.
- Never confuse the control plane (MCP/Graph/webhook, request-response) with the
  media plane (SIP/RTP audio).
- Scope MCP call tools independently so a messaging key cannot place calls.
- Prefer WhatsApp SIP mode → Asterisk → Dograh over a custom WebRTC terminator.
- Gate all build work behind confirmed account eligibility.

## Phase 0: Eligibility and validation (blocking)

1. Confirm target regions are not on the exclusion list (US, Canada, Turkey,
   Egypt, Vietnam, Nigeria).
2. Confirm the WABA phone number can be Calling-enabled and is at 1K+ messaging
   tier with sufficient conversation limit.
3. Validate the **business-initiated-over-SIP handshake** against Meta's SIP
   integration guide (inbound SIP INVITE is well-trodden; business-initiated over
   SIP is the unknown). Spike a single manual call end-to-end.
4. Confirm codec path: Meta OPUS/PCMU/PCMA vs the chosen STT / speech-to-speech
   input; measure the Asterisk transcode latency hop.
5. Confirm Dograh runtime MCP-tool support (external MCP server called as a tool
   during a conversation, not just build-time coding-agent MCP).

Deliverable:

- Go/no-go on eligibility, a chosen media path (SIP vs WebRTC fallback), and a
  validated one-call proof of concept.

## Phase 1: Calling control plane (Pons)

1. Add a `calls` table to [schema.ts](convex/schema.ts): account, contact,
   direction, status, `waCallId`, `dograhSessionId`, timestamps, error fields.
2. Add `convex/whatsappCalls.ts` mirroring [whatsapp.ts](convex/whatsapp.ts):
   - `requestCallPermission` (interactive consent message)
   - `initiateCall` (`POST /{phoneNumberId}/calls`, `action: connect`, SDP)
   - `terminateCall`
3. Extend `formatMetaError` in [metaFetch.ts](convex/metaFetch.ts) with
   call-specific subcodes (no consent, number not calling-enabled).
4. Add call records + `call.*` events through `forwarding.enqueueEvent`.

Deliverable:

- Pons can send consent, initiate, and terminate a call, with lifecycle stored.

## Phase 2: Inbound call events (webhook)

1. Widen the drop-gate in [route.ts](src/app/api/webhook/route.ts) to accept
   `change.field === "calls"`.
2. Extend `webhookValueSchema` with a `calls` array.
3. Add `gateway.webhookCallEvent` beside `webhookStatusUpdate` (same
   signature-verify-then-ingest pattern).
4. Add `ingestCallEvent` in [webhook.ts](convex/webhook.ts) beside
   `ingestStatusUpdate`, updating the `calls` table on
   `ringing`/`accepted`/`rejected`/`terminated` and the consent-grant event.

Deliverable:

- Call lifecycle and consent events flow into Pons and appear on the
  conversation timeline.

## Phase 3: Media bridge (Asterisk + Dograh)

1. Stand up Asterisk (or Kamailio) as a SIP B2BUA; configure the WhatsApp SIP
   trunk / calling connection.
2. Configure transcoding (OPUS ↔ target codec) as required.
3. Deploy Dograh via Docker Compose; connect BYO STT/LLM/TTS or speech-to-speech.
4. Wire Asterisk ARI to a Dograh inbound workflow; verify outbound connect from
   Phase 1 anchors media to Asterisk.
5. Persist the Dograh session id back onto the Pons `calls` record for
   correlation.

Deliverable:

- A business-initiated and an inbound WhatsApp call each reach a live Dograh
  agent, with transcript/recording linked from the Pons call record.

## Phase 4: MCP integration — Direction A (drive calls)

1. Add scopes `calls:read` / `calls:write` to `VALID_SCOPES` in
   [mcp.ts](convex/mcp.ts).
2. Add a `CALL_TOOLS` group in [gateway.ts](convex/gateway.ts):
   `request_call_permission`, `start_call`, `end_call`, `get_call`, `list_calls`.
3. Add a `calls:*` branch to `assertMcpToolPermissions`.
4. Add `case` arms in the `runMcpTool` switch delegating to `whatsappCalls.ts`.

Deliverable:

- An MCP client can request consent, place, monitor, and end a WhatsApp voice
  call that is answered by the Dograh agent.

## Phase 5: MCP integration — Direction B (agent acts mid-call)

1. Issue Dograh a Pons MCP API key scoped narrowly (e.g. `send`,
   `conversations:read`; not `calls:write`).
2. Configure Dograh workflow nodes to call Pons MCP messaging tools during a
   call (`send_template`, `send_media`, `send_text`, `get_conversation`).
3. Verify unified conversation: voice + chat land on the same contact/record.

Deliverable:

- The in-call voice agent can send WhatsApp messages and read history through the
  same MCP, closing the omnichannel loop.

## Phase 6: Hardening and rollout

1. Consent/window enforcement (5 calls/24h, 7-day window) with clear errors.
2. Rate limiting, per-account calling enablement flags, and abuse guards.
3. Observability: call logs, Dograh traces/recordings linked from Pons.
4. Failure handling: media bridge down, transcode failure, provider outage.
5. Docs for enabling calling per account and configuring the Dograh key.

Deliverable:

- Production-ready calling with guardrails, observability, and documentation.

## Important Notes

- Do not build anything before Phase 0 eligibility is confirmed.
- MCP is never the media path; audio always flows SIP/RTP to Asterisk→Dograh.
- Keep the media plane outside Convex; do not attempt RTP in an action.
- Scope call tools separately from messaging tools.
- Prefer SIP mode; only fall back to a custom WebRTC terminator if SIP mode
  cannot be enabled on the number.
- Business-initiated-over-SIP is the single largest unknown — validate first.

## Verification Checklist

- Target region and number are calling-eligible (1K+ tier).
- Consent request delivers; user grant is recorded via the `calls` webhook.
- Business-initiated call connects and reaches a live Dograh agent.
- Inbound call routes via Asterisk ARI to a Dograh inbound workflow.
- Call lifecycle events (ringing/accepted/rejected/terminated) update the `calls`
  record and conversation timeline.
- Dograh session id is correlated on the Pons call record.
- MCP `calls:*` tools place/monitor/end a call (Direction A).
- A messaging-scoped Dograh key can send WhatsApp messages mid-call (Direction B)
  and cannot place calls.
- Messaging, auth, and existing MCP tools are unchanged.
</content>
</invoke>
