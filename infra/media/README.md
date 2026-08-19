# WhatsApp Voice Agent — Media Plane (Phase 3)

Runbook for the **self-hosted media plane** that bridges a WhatsApp Business call
into a [Dograh](https://github.com/dograh-hq/dograh) voice agent, and correlates
the session back to Pons.

> **Status: SCAFFOLDING / TEMPLATE — not yet validated end-to-end.**
> The Pons-side correlation endpoint (`POST /api/media/session`) is implemented
> and typechecked. Everything in this directory (`docker-compose.yml`, the
> `asterisk/` configs) is a **starting template** with placeholders. It has NOT
> been run against a live WhatsApp SIP connection. Standing this up requires a
> calling-enabled WABA number in a supported region and the real values from
> Meta's SIP Configuration guide (see "Phase 0 unknowns" below).

## Where this sits

```
WhatsApp user (voice)
        │  SIP + SRTP (OPUS)
        ▼
   Asterisk / Kamailio ──ARI──▶ Dograh (Pipecat) ──▶ BYO STT / LLM / TTS
   (this directory)               │
        ▲                         │ 1. on media established:
        │ Graph API               │    POST /api/media/session
   WhatsApp Calling API           ▼    { waCallId, dograhSessionId, status }
        └───────────────────▶ PONS (control plane)
   consent / POST /calls /        • attaches dograhSessionId to the call record
   calls webhook (Phases 1-2)     • unified call timeline
```

- **Pons** owns consent, call initiation, the `calls` webhook, and the call
  record (Phases 1–2). It never touches audio.
- **Asterisk** terminates Meta's SIP + SRTP and bridges the call to Dograh over
  ARI. This is the only new infra component.
- **Dograh** runs the agent (turn-taking, STT/LLM/TTS or speech-to-speech).
- After media is established, the bridge calls Pons `POST /api/media/session` to
  record the Dograh session id against the call (`waCallId`).

## Prerequisites (Phase 0 — must be confirmed first)

1. WABA number is **Calling-enabled** by Meta, at the **1K messaging tier** or
   higher, and in a **supported region** (excludes US, Canada, Turkey, Egypt,
   Vietnam, Nigeria as of mid-2025).
2. The number's calling connection is configured for **SIP mode** (not the
   default Graph+WebRTC), pointing at your Asterisk endpoint. Get the SIP server
   host / credentials / codec requirements from Meta's SIP Configuration guide.
3. Docker + Docker Compose on the media host.

## Phase 0 unknowns to validate before relying on this

- **Business-initiated over SIP**: inbound SIP INVITE is well-trodden;
  business-initiated calls anchoring media to your SIP endpoint is the primary
  unknown. Prove one manual call end-to-end first.
- **SDP handshake**: for outbound, Pons `initiateCall` sends an SDP offer to Meta
  and Meta returns an answer. In SIP mode the offer/answer is produced/consumed
  by Asterisk. Confirm exactly where the SDP is generated and how Meta's answer
  reaches Asterisk.
- **Codec/transcoding**: Meta does OPUS / PCMU / PCMA. Confirm Asterisk
  transcodes cleanly to the codec your STT / speech-to-speech provider expects
  and measure the added latency.
- **Webhook enum casing** for the `calls` field (Phase 2 parses tolerantly).

## Setup (once prerequisites are met)

1. Copy `.env.example` to `.env` and fill in every placeholder.
2. Deploy Dograh (its own compose stack per its docs) and create an inbound
   workflow / agent; note the ARI connection details.
3. Fill in `asterisk/pjsip.conf` with the Meta SIP trunk and the Dograh/ARI
   endpoint, `asterisk/extensions.conf` with the dialplan, and `asterisk/ari.conf`
   with the ARI user Dograh uses.
4. `docker compose up -d` and place a test call.

## Pons integration contract (implemented)

- **Endpoint**: `POST /api/media/session`
- **Auth**: header `x-pons-media-secret: <MEDIA_BRIDGE_SECRET>` (timing-safe
  compared; the Convex action re-verifies it).
- **Body**:
  ```json
  {
    "waCallId": "wacid...",
    "dograhSessionId": "<dograh-session-id>",
    "status": "connected"
  }
  ```
  `status` is optional; allowed values: `connecting`, `connected`, `completed`,
  `terminated`, `rejected`, `failed`. When set to `connected` the call's
  `connectedAt` is stamped; terminal values stamp `endedAt`.
- **Responses**: `200 {ok:true, callId}` · `404 {ok:false,error:"call_not_found"}`
  · `401` unauthorized · `500` misconfigured/unset secret.

Set `MEDIA_BRIDGE_SECRET` in **both** the Next.js runtime env and the Convex
deployment env (the Convex action reads it too).

## Files

| File | Purpose | Status |
|---|---|---|
| `docker-compose.yml` | Asterisk service (+ Dograh reference) | template |
| `asterisk/pjsip.conf` | Meta SIP trunk + Dograh/ARI endpoint | template |
| `asterisk/extensions.conf` | dialplan → Stasis(dograh) | template |
| `asterisk/ari.conf` | ARI user for Dograh | template |
| `.env.example` | required environment variables | template |

The Pons endpoint (`src/app/api/media/session/route.ts`,
`convex/gateway.ts:attachCallSession`, `convex/calls.ts:attachDograhSession`) is
implemented and typechecked.
