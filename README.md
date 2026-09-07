# CircuitMate — bench copilot for hands-busy builders

Browser voice demo on the **AssemblyAI Voice Agent API** (single WebSocket: STT + LLM + TTS + turn-taking).
Keys stay server-side; the browser gets a short-lived single-use token per call.

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

- `src/server.ts` — static + `/api/config`, `/api/voice-token`, `/api/tool/*`
- `src/agent/circuitmate.json` — prompt, greeting, voice `alba`, keyterms, 3 tools
- `src/circuit-tools.ts` + `src/knowledge/*.json` — small local KB (no RAG/DB)
- `public/` — instrument UI (READY/LISTENING/THINKING/SPEAKING/INTERRUPTED), worklet, mock mode
