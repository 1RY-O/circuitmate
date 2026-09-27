# CircuitMate — Volcanic Brutalist Bench Copilot

**CircuitMate** is an aggressive, high-energy voice copilot engineered for hands-busy electronics, robotics, and hardware hackers working with live circuits, molten solder, and precision instruments.

Powered by the **AssemblyAI Voice Agent API** over a full-duplex WebSocket connection (streaming STT + LLM reasoning + low-latency TTS + server-driven turn-taking and barge-in), CircuitMate executes zero-latency diagnostic calculations, component pinout inspections, and fault tree traversals completely hands-free.

---

### The Aesthetic: Volcanic Brutalism (Active Theory Inspired)
Designed like a glowing forge console or an industrial military bench analyzer, the UI rejects soft consumer aesthetics in favor of raw mechanical energy:
- **Obsidian & Magma Palette:** Deep `#090606` obsidian bedrock, razor-sharp `#110a0a` panels with hot magma borders (`#ff4500`), molten gold status arcs (`#ff8c00`), superheated red reasoning traces (`#ff2a00`), and crimson tripwires (`#d90429`).
- **Zero-Radius Brutalist Geometry:** All borders, panels, and badges are sheared to hard `0px` edges with sharp 1px magma elevations.
- **Harsh Forge Hatch & Radiant Heat Floor:** The bench backdrop trades boring blueprints for a raw diagonal cross-hatch pattern masked over an aggressive bottom-center heat source that bleeds upward under the chassis.
- **Mitered Oscilloscope Traces & Flat-Packet Data Core:** Live audio waveforms render with mitered, jagged peaks instead of softened curves; the central HUD signal core fires flat-edged, square-capped data packets across its tracking arc.

---

### Core Technical Flexes
1. **AssemblyAI Voice Agent API Integration:**
   - Single full-duplex WebSocket (`wss://agents.assemblyai.com/v1/ws`) managing real-time STT, LLM reasoning, speech synthesis, and millisecond barge-in interruption.
   - Client-side function tool orchestration (`lookup_component`, `calc_circuit`, `debug_step`) executing local deterministic knowledge-base lookups with zero RAG latency.
2. **Custom Ephemeral Token Minting Server:**
   - Master `ASSEMBLYAI_API_KEY` never touches the browser.
   - Microservice backend mints short-lived, single-use, 120-second scoped session tokens via `GET /api/voice-token` with strict upstream error obfuscation and fixed-window layered rate limiting.
3. **Web Audio API Worklet Resampler:**
   - Dedicated `AudioWorkletNode` (`public/pcm-processor.js`) running on an isolated audio rendering thread.
   - Runs the hardware `AudioContext` at native device rates (44.1kHz / 48kHz / 96kHz) so browser hardware echo cancellation remains engaged, and linearly resamples the float32 stream down to 24kHz mono PCM16 buffers before base64 ingestion. Eliminates Safari sample-rate clamp bugs and Firefox cancellation drops.
4. **Hardened Security & Strict Content Security Policy (CSP):**
   - Hardened HTTP headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`).
   - Locked-down CSP strictly restricting WebSocket connections and scripts (`connect-src 'self' https://agents.assemblyai.com wss://agents.assemblyai.com; default-src 'self'`).
   - Anti-traversal static file serving preventing directory escape, with fully sanitized input validation on all circuit computation routes.

---

## Quickstart

```bash
cp .env.example .env        # paste ASSEMBLYAI_API_KEY
npm install
npm run publish             # POST src/agent/circuitmate.json -> writes AGENT_ID to .env
npm run dev                 # http://localhost:3000 (Chrome/Edge + mic)
```

No key? The UI shows an explicit **ERROR** state (never silent mock).
Append `?mock=1` or press **OFFLINE** for deliberate offline tool testing.

## Verify the real voice loop (headless, no mic)

```bash
npm test                          # 8 unit tests: tools, no-assumption calc/debug, safety
npm run check:voice               # live handshake (B) + live-text injection (C) over the real API
node scripts/voice-speech-loop.mjs  # full speech-in/out: SAPI WAVs -> STT -> tools -> TTS
```

`voice-speech-loop.mjs` needs the server (`npm run dev`) and the two WAVs in
`%LOCALAPPDATA%\Temp\opencode\turn{1,2}.wav` (24kHz PCM16 mono; render with
`System.Speech` `SpeechAudioFormatInfo`, see chat history). It asserts STT turns,
verbatim-symptom tool call, a disambiguating spoken answer, audio chunks, clean close.

## Manual browser matrix (needs human + mic)

1. Badge LIVE → START → greeting speaks; mic meter moves; transcript shows words.
2. *"My Arduino LED isn't lighting up"* → must ask built-in-vs-external, no ohms.
3. Talk over a reply → INTERRUPTED, audio stops, turn continues.
4. Type in the box mid-call → spoken reply via `conversation.message` + `reply.create`.
5. Kill server / revoke key → ERROR badge + message, never mock.

## 2-minute judge script

1. START CALL → greet. Say: *“white LED on 5 volts, what resistor?”* → calls `calc_circuit`, speaks “180 ohm”, readout card shows math.
2. Say: *“it’s still dim, nothing lights”* → calls `debug_step`, asks ONE question (polarity? rail split?).
3. Talk over the reply → barge-in cuts audio (`reply.done: interrupted`, buffer flushed), state lamp flashes INTERRUPTED → LISTENING.

## How it maps to the docs

- Token: `GET https://agents.assemblyai.com/v1/token` (Bearer, `expires_in_seconds=120`) → browser `wss://agents.assemblyai.com/v1/ws?token=`
- First frame `session.update {agent_id}` **alone** (anything alongside agent_id → `invalid_value`), wait `session.ready` before `input.audio`
- Audio `audio/pcm` 24kHz mono base64; mic `echoCancellation:true, noiseSuppression:false`; worklet resamples (Firefox/Safari-safe)
- Events: `input.speech.started/stopped`, `transcript.user(.delta)`, `reply.started/audio/done`, `transcript.agent(.delta)`, `tool.call` → `tool.result` (sent when `reply.done` is latest), `session.end` → `session.ended`
- Tools are **client-side function tools** (HTTP tools require public https, so localhost KB runs in-browser via `/api/tool/*`)
- Stored agent REST uses the **bare** key; voice WS/token use **Bearer**

## Files

- `src/server.ts` — static + `/api/config`, `/api/voice-token`, `/api/tool/*`, `/api/agent`, `/api/health`, `/api/knowledge/*`
- `src/rate-limit.ts` — dependency-free in-memory fixed-window rate limiter
- `src/logger.ts` — compact JSON-line logger (access + events, never tokens/secrets)
- `src/voice-token.ts` — server-side AssemblyAI token minting with safe error mapping
- `src/agent/circuitmate.json` — prompt, greeting, voice `alba`, keyterms, 3 tools
- `src/circuit-tools.ts` + `src/knowledge/*.json` — small local KB (no RAG/DB)
- `public/` — brutalist volcanic console UI, canvas oscilloscope, signal core HUD, audio worklet

## Backend API contract

All `/api/*` responses are JSON, `Cache-Control: no-store`, and carry hardening headers
(`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
and strict Content-Security-Policy).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | `{ agentId, mock, wsUrl }` — never the API key |
| `GET /api/voice-token` | `{ token }` — mints a short-lived single-use AssemblyAI token |
| `GET /api/knowledge/:set` | components / faults / safety KB (read-only) |
| `POST /api/tool/:name` | `lookup_component`, `calc_circuit`, `debug_step` |
| `GET /api/health` / `GET /api/agent` | `{ ok, mock, agentConfigured }` |

## Security architecture

- **Keys stay server-side.** The browser only ever receives a minted, single-use,
  120-second token; it never sees `ASSEMBLYAI_API_KEY`. Token scope/expiry is AssemblyAI's
  `expires_in_seconds` + `max_session_duration_seconds` — reused, not reinvented.
- **Token endpoint validation** happens before minting: query strings are rejected (parameters
  are fixed server-side), body size is capped, and the key must be present (else `503 {mock:true}`).
- **Layered rate limiting** (in-memory fixed-window):
  - `/api/voice-token`: 6 mints/min per IP, 24/min server-wide.
  - `/api/tool/*`: 120/min per IP, 600/min server-wide.
  - Limiters reset on restart and are single-process only.
- **Safe errors.** Upstream token failures map to a generic `502`; the client never sees upstream
  bodies, HTTP statuses, or internal messages. Details are logged server-side (category + status)
  without the key or token.
- **Input limits.** Request body ≤ 256KB; `query` ≤ 200 chars; `symptom` ≤ 2000 chars;
  `calc_circuit` numbers must be finite, positive, and inside physical bounds — a single
  malformed value returns `400` instead of silently emitting `Infinity`/`null`.
- **Static serving** never escapes `public/` (path-normalization guard), and path segments of `..`
  plus malformed percent-encoding are rejected instead of crashing the server.
- **No command execution, no file writes, no network from tools.** `lookup_component`,
  `calc_circuit`, and `debug_step` are pure reads over the bundled KB. There is no general-purpose
  execution endpoint.

### Residual risks (documented, not hidden)

- The `/api/voice-token` endpoint is unauthenticated. Anyone who can reach the server can spend
  AssemblyAI quota; rate limits bound the *rate* of damage (and unused tokens expire in 120s), but
  cannot prevent it. **Monitor AssemblyAI usage + the `token.issued`/`token.mint_failed` log lines.**
- In-memory rate limits don't survive restarts and assume a single server process. Fine for this
  MVP; a load-balanced deployment would need shared storage.
- Per-IP limits key on the TCP peer address. Set `TRUST_PROXY=1` **only** behind a reverse proxy
  that strips `X-Forwarded-For` — enabling it insecurely lets clients spoof IPs and override limits.
- Bind `HOST=127.0.0.1` if you don't need LAN access; default `0.0.0.0` is the mobile-demo default.
- The stack trace, upstream status, and token-issuance internals are never returned to clients but
  DO appear in server logs (visible only to the operator).
- If this demo goes public and abuse becomes real, the minimal next step is a shared `AUTH_TOKEN`
  env the browser sends as a header — that requires a matching `public/app.js` change by the
  frontend owner.

## Environment

`HOST` (default `0.0.0.0`), `PORT` (default `3000`), `LOG_LEVEL` (`silent|error|warn|info|debug`),
`TRUST_PROXY` (`0` default), plus `ASSEMBLYAI_API_KEY` and `AGENT_ID`. `.env` is git-ignored;
only `.env.example` is tracked.
