// CircuitMate instrument UI.
// Voice core unchanged: mic -> AudioWorklet PCM16 -> AssemblyAI Voice Agent WS -> TTS out + barge-in.
// This layer only RENDERS: scope canvas, state machine, diagnostic readouts, transcript, tool bus.
// Protocol notes baked in (from live debugging):
// - agent_id is MUTUALLY EXCLUSIVE with other session fields (else invalid_value).
// - reply.audio chunk field is `data` (base64 PCM16 24kHz mono); tool.result is sent
//   when reply.done is the latest event; pre-handshake failures surface as close 1006.

const $ = (id) => document.getElementById(id);

const modeBadge = $("modeBadge"), sessionLabel = $("sessionLabel"), demoBanner = $("demoBanner");
const demoBannerText = demoBanner ? demoBanner.querySelector(".demo-banner-text") : null;
const stateText = $("stateText"), stateSub = $("stateSub");
const micLevel = $("micLevel"), agentLevel = $("agentLevel");
const logEl = $("log"), cardsEl = $("cards"), checklistEl = $("checklist"), toolBusEl = $("toolBus");
const startBtn = $("startBtn"), endBtn = $("endBtn"), interruptBtn = $("interruptBtn");
const coreBtn = $("coreBtn"), coreLabel = $("coreLabel");
const transportLog = $("transportLog");
const roKnown = $("roKnown"), roUnknown = $("roUnknown"), roHypo = $("roHypo"), roNext = $("roNext");
const progFill = $("progFill"), progText = $("progText");
const scope = $("scope"), textInput = $("textInput");
const sctx = scope.getContext("2d");

const mqReduce = matchMedia("(prefers-reduced-motion: reduce)");
const reduceMotion = () => mqReduce.matches;

// ---- mode is explicit: 'live' | 'mock' | 'error'. Never a silent fake AI. ----
let mode = "live";
function setMode(m, label) {
  mode = m;
  modeBadge.textContent = label;
  modeBadge.className = "badge " + (m === "live" ? "live" : m === "mock" ? "demo" : "error");
  if (textInput) {
    textInput.disabled = m === "error";
    textInput.placeholder = m === "mock"
      ? "offline demo — type to drive the diagnostic tools…"
      : m === "error" ? "unavailable — fix the connection first…"
      : "type a note — inside a live call it reaches the agent…";
  }
}

// ---- protocol/session state ----
let cfg = { agentId: "", mock: true, wsUrl: "wss://agents.assemblyai.com/v1/ws" };
let ws = null, audioCtx = null, micStream = null, worklet = null, analyser = null, agentAnalyser = null;
let ready = false, cleanEnd = false, sessionId = null, lastEvent = null, pendingTools = [];
// Temporary stage timing (offline-safe, client-observable legs only):
// speech.stopped -> reply.started ~= AssemblyAI STT+LLM+TTS turn time;
// reply.started -> first reply.audio ~= TTS first-byte time.
let thinkT0 = 0, replyT0 = 0;
let playbackTime = 0, playSources = [], userRow = null, agentRow = null, replyWatchdog = null, replyAudioCount = 0;

// ---- UI state machine: one signal color drives the whole console ----
let uiState = "ready", micEnv = 0, agentEnv = 0, stateTimer = null, micData = null, agentData = null;

function setButtons() {
  const inCall = ["connecting", "listening", "transcribing", "thinking", "speaking", "interrupted"].includes(uiState);
  startBtn.disabled = !(uiState === "ready" || uiState === "error");
  endBtn.disabled = !inCall;
  interruptBtn.disabled = !ready;
  coreLabel.textContent = inCall ? "END" : "START";
  coreBtn.setAttribute("aria-label", inCall ? "End call — close voice channel" : "Start call — open voice channel");
}
// display names for the voice states (data-state keys stay unchanged)
const DISPLAY_STATE = { READY: "IDLE", SPEAKING: "RESPONDING" };
function setState(s, sub) {
  clearTimeout(stateTimer);
  uiState = s.toLowerCase();
  document.body.dataset.state = uiState;
  refreshScopeColor();
  const label = DISPLAY_STATE[s] ?? s;
  const scopeState = document.getElementById("scopeState"); // bezel readout stays in sync even without the motion layer
  if (scopeState) scopeState.textContent = label;
  if (window.CM) CM.enterState(label, sub); // crossfaded by the choreography layer
  else { stateText.textContent = label; if (sub) stateSub.textContent = sub; }
  setButtons();
}
function setStateThen(s, sub, backTo, backSub, ms) {
  setState(s, sub);
  stateTimer = setTimeout(() => { if (uiState === s.toLowerCase()) setState(backTo, backSub); }, ms);
}

// ---- friendly status + error text (never expose internals) ----
const FRIENDLY_EVENT = {
  "session.ready": "channel open",
  "input.speech.started": "hearing you…",
  "input.speech.stopped": "turn captured",
  "transcript.user.delta": "capturing…",
  "transcript.user": "turn captured",
  "reply.started": "agent speaking…",
  "reply.audio": "agent speaking…",
  "transcript.agent.delta": "agent speaking…",
  "transcript.agent": "agent reply complete",
  "reply.done": "reply complete",
  "tool.call": "running diagnostic tool…",
  "session.ended": "channel closed",
  "session.error": "agent error",
  "error": "error",
};
function setTransport(text) { transportLog.textContent = text; }

function friendlyError(what) {
  const s = String(what ?? "");
  if (/token endpoint HTTP \d+/.test(s)) return "The voice service couldn't be reached. Check your connection and try again.";
  if (/token request failed/.test(s)) return "Couldn't reach the server. Check that it's running and try again.";
  if (/token endpoint returned no token/.test(s)) return "The voice service didn't return a token. Try again in a moment.";
  if (/mic blocked/.test(s)) return "Microphone access was blocked. Allow mic permission in your browser, then try again.";
  if (/could not reach \/api\/config/.test(s)) return "Couldn't reach the server. Check that it's running and refresh.";
  if (/socket closed code=1006/.test(s)) return "The voice connection dropped before it opened. Try again — a fresh connection is created each time.";
  if (/socket closed/.test(s)) return "The voice connection dropped. Press START to reconnect.";
  if (/connect failed/.test(s)) return "Couldn't open the voice connection. Check your network and try again.";
  if (/agent started a reply/.test(s)) return "The agent replied but no audio came through. Check your speakers or volume, then try again.";
  if (/reply completed with zero audio/.test(s)) return "The agent replied but no audio came through. Check your speakers or volume, then try again.";
  if (/audio playback failed/.test(s)) return "Audio playback failed. Check your speakers or volume, then try again.";
  if (/bad server frame/.test(s)) return "The voice service sent an unexpected message. Try again.";
  if (/WebSocket error/.test(s)) return "The voice connection hit an error. Try again — a fresh connection is created each time.";
  if (/not connected/.test(s)) return "You're not connected yet. Press START CALL first.";
  if (/tool .* failed/.test(s)) return "A diagnostic tool failed. Check your connection and try again.";
  return s.length > 0 ? s : "Something went wrong. Try again.";
}

// ---- async start cancellation + cached scope color ----
let abortStart = false;
let scopeStateColor = "#64748b";
function refreshScopeColor() {
  scopeStateColor = getComputedStyle(document.body).getPropertyValue("--state").trim() || "#64748b";
}

// ---- oscilloscope: CH1 mic (green, live analyser) · CH2 agent (amber, playback tap) ----
let scopeW = 0, scopeH = 0, lastFrame = 0;
const chIn = document.querySelector(".ch-in"), chOut = document.querySelector(".ch-out");
new ResizeObserver(() => {
  const r = scope.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  scope.width = Math.max(1, Math.round(r.width * dpr));
  scope.height = Math.max(1, Math.round(r.height * dpr));
  scopeW = scope.width; scopeH = scope.height;
}).observe(scope);

// ---- core ring readout — small canvas layered over the mic core ----
const coreSignal = document.getElementById("coreSignal");
const csCtx = coreSignal ? coreSignal.getContext("2d") : null;
let csW = 0, csH = 0;
if (coreSignal) {
  new ResizeObserver(() => {
    const r = coreSignal.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    coreSignal.width = Math.max(1, Math.round(r.width * dpr));
    coreSignal.height = Math.max(1, Math.round(r.height * dpr));
    csW = coreSignal.width; csH = coreSignal.height;
  }).observe(coreSignal);
}

function rms(data) {
  let s = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; s += v * v; }
  return Math.sqrt(s / data.length);
}

// Envelope: fast but smooth attack, gentle release — level breathes with the
// voice, then decays back into idle instead of snapping off.
function smoothEnv(env, level) {
  return level > env ? env + (level - env) * 0.55 : env * 0.94;
}

// Light low-pass on the raw analyser data: a controlled trace, not a jitter.
let smMic = null, smAgent = null;
function smoothData(raw, out) {
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i] / 128 - 1; // DC-centered -1..1
    out[i] += (v - out[i]) * 0.45;
  }
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Two-pass stroke: wide faint under-swell + thin crisp core. A soft phosphor
// trace without per-frame shadowBlur cost.
function drawTrace(data, rgb, alpha, gain) {
  const n = data.length;
  const pass = (lw, a) => {
    sctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * scopeW;
      const y = scopeH / 2 - data[i] * (scopeH / 2) * gain;
      i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
    }
    sctx.strokeStyle = `rgba(${rgb},${a})`;
    sctx.lineWidth = lw;
    sctx.lineJoin = "round";
    sctx.stroke();
  };
  pass(Math.max(2.5, scopeH / 120), alpha * 0.16);
  pass(Math.max(1, scopeH / 250), alpha);
}

function drawScope(ts) {
  requestAnimationFrame(drawScope);
  if (!scopeW) return;
  if (reduceMotion() && ts - lastFrame < 220) return;
  lastFrame = ts;
  const w = scopeW, h = scopeH, mid = h / 2;

  // envelopes drive meters, LEDs, the core halo, and trace presence
  let micRms = 0, agentRms = 0;
  if (analyser && micData) {
    analyser.getByteTimeDomainData(micData);
    micRms = rms(micData);
    micEnv = smoothEnv(micEnv, micRms);
  }
  if (agentAnalyser && agentData) {
    agentAnalyser.getByteTimeDomainData(agentData);
    agentRms = rms(agentData);
    agentEnv = smoothEnv(agentEnv, agentRms);
  }
  document.documentElement.style.setProperty("--core-env",
    (uiState === "listening" ? micEnv : uiState === "speaking" ? agentEnv : 0).toFixed(3));
  micLevel.style.width = Math.min(100, micEnv * 260) + "%";
  agentLevel.style.width = Math.min(100, agentEnv * 260) + "%";
  chIn.classList.toggle("active", micRms > 0.02);
  chOut.classList.toggle("active", agentRms > 0.02);

  // graticule
  sctx.clearRect(0, 0, w, h);
  sctx.strokeStyle = "rgba(96,130,170,0.08)";
  sctx.lineWidth = 1;
  sctx.beginPath();
  for (let i = 1; i < 12; i++) { const x = Math.round((i / 12) * w) + 0.5; sctx.moveTo(x, 0); sctx.lineTo(x, h); }
  for (let j = 1; j < 4; j++) { const y = Math.round((j / 4) * h) + 0.5; sctx.moveTo(0, y); sctx.lineTo(w, y); }
  sctx.stroke();
  sctx.strokeStyle = "rgba(96,130,170,0.14)";
  sctx.beginPath(); sctx.moveTo(0, mid + 0.5); sctx.lineTo(w, mid + 0.5); sctx.stroke();

  const stateColor = scopeStateColor;

  // live traces — gated on the smoothed envelope so they fade out, not snap
  if (analyser && micData && micEnv > 0.003) {
    if (!smMic || smMic.length !== micData.length) smMic = new Float32Array(micData.length);
    smoothData(micData, smMic);
    drawTrace(smMic, "74,222,128", Math.min(1, 0.34 + micEnv * 3), 1.05);
  }
  if (agentAnalyser && agentData && agentEnv > 0.003) {
    if (!smAgent || smAgent.length !== agentData.length) smAgent = new Float32Array(agentData.length);
    smoothData(agentData, smAgent);
    drawTrace(smAgent, "251,191,36", Math.min(1, 0.34 + agentEnv * 3), 1.05);
  }

  // calm idle: a still, state-flushed baseline; while connecting/thinking a
  // single slow signal pulse travels it (system establishing / processing).
  if (micEnv <= 0.003 && agentEnv <= 0.003) {
    const busy = uiState === "connecting" || uiState === "thinking";
    sctx.strokeStyle = stateColor;
    sctx.globalAlpha = busy ? 0.38 : 0.26;
    sctx.lineWidth = 1;
    sctx.beginPath(); sctx.moveTo(0, mid + 0.5); sctx.lineTo(w, mid + 0.5); sctx.stroke();
    sctx.globalAlpha = 1;
    if (busy && !reduceMotion()) {
      const period = uiState === "connecting" ? 2600 : 3800;
      const sx = ((ts % period) / period) * w;
      const head = 26;
      const grad = sctx.createLinearGradient(sx - head, 0, sx, 0);
      grad.addColorStop(0, hexToRgba(stateColor, 0));
      grad.addColorStop(1, hexToRgba(stateColor, 0.5));
      sctx.strokeStyle = grad;
      sctx.lineWidth = 1.4;
      sctx.beginPath(); sctx.moveTo(sx - head, mid + 0.5); sctx.lineTo(sx, mid + 0.5); sctx.stroke();
    }
  }

  drawSignalCore(ts);
}
requestAnimationFrame(drawScope);

// ---- core ring: static hairline + one arc gliding around it ----
// The arc is a "signal pulse": slow calm travel at rest, slightly faster while
// the system connects/processes, and it stretches with input energy while the
// voice is live — so louder speech reads as a longer signal, not a bounce.
function drawSignalCore(ts) {
  if (!coreSignal || !csCtx || !csW || !csH) return;
  const cx = csW / 2, cy = csH / 2, R = Math.min(csW, csH) / 2 - 2;
  csCtx.clearRect(0, 0, csW, csH);

  const live = (uiState === "listening" || uiState === "transcribing") ? micEnv
    : uiState === "speaking" ? agentEnv : 0;
  const awake = uiState === "connecting" || uiState === "thinking" || live > 0.004;
  const color = scopeStateColor;

  csCtx.lineWidth = 1;
  csCtx.strokeStyle = hexToRgba(color, awake ? 0.55 : 0.24);
  csCtx.beginPath(); csCtx.arc(cx, cy, R, 0, Math.PI * 2); csCtx.stroke();

  if (reduceMotion()) return; // static ring only

  let lap, arc, alpha;
  if (uiState === "connecting" || uiState === "thinking") {
    lap = uiState === "connecting" ? 2600 : 3600;
    arc = 0.14;
    alpha = 0.6;
  } else if (live > 0.004) {
    lap = 7200;
    arc = Math.min(0.5, 0.1 + live * 2.4);
    alpha = 0.85;
  } else {
    lap = 9000;
    arc = 0.07;
    alpha = 0.4;
  }
  const t = (ts % lap) / lap;
  const a0 = t * Math.PI * 2;
  const a1 = a0 + arc * Math.PI * 2;
  csCtx.lineWidth = 2;
  csCtx.strokeStyle = hexToRgba(color, alpha);
  csCtx.lineCap = "round";
  csCtx.beginPath(); csCtx.arc(cx, cy, R, a0, a1); csCtx.stroke();
  csCtx.lineCap = "butt";
}

// ---- transcript: signal-log rows (time · tag · text), partials with caret ----
const TAGS = { u: "USER", a: "CIRCUITMATE", sys: "SYSTEM", tool: "TOOL" };
const stamp = () => new Date().toTimeString().slice(0, 8);
function mkRow(kind, demo = false) {
  document.getElementById("logEmpty")?.remove(); // leave the designed empty state
  const row = document.createElement("div");
  row.className = "tr " + kind + (demo ? " demo" : "");
  const t = document.createElement("span"); t.className = "tr-time"; t.textContent = stamp();
  const tag = document.createElement("span"); tag.className = "tr-tag"; tag.textContent = TAGS[kind] ?? kind.toUpperCase();
  const tx = document.createElement("span"); tx.className = "tr-text";
  row.append(t, tag, tx);
  logEl.appendChild(row);
  while (logEl.children.length > 140) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  window.CM?.rowIn(row);
  return { row, tx };
}
function log(kind, text, demo = false) { mkRow(kind, demo).tx.textContent = text; }
const logErr = (text) => log("sys", "ERROR: " + text);

// ---- diagnostic model: KNOWN → UNKNOWN → HYPOTHESIS → NEXT ACTION → PROGRESS ----
const diag = { known: new Set(), unknown: null, hypo: null, next: null, step: 0, total: 4, lastTopic: null };
const KNOWN_PATTERNS = [
  [/\barduino\s*(uno)?\b/i, "ARDUINO UNO"], [/\besp32\b/i, "ESP32"],
  [/\braspberry\s*pi\b/i, "RASPBERRY PI"], [/\bbreadboard\b/i, "BREADBOARD"],
  [/\bled(s)?\b/i, "LED"], [/\bservo\b/i, "SERVO"], [/\bmotors?\b/i, "MOTOR"],
  [/\bdht\s*22?\b/i, "DHT22"], [/\bhc[-\s]?sr04\b|ultrasonic/i, "HC-SR04"],
  [/\bmqtt\b/i, "MQTT"], [/\bresistors?\b/i, "RESISTOR"],
];
const SYMPTOM_RE = /\b(won'?t|wouldn'?t|doesn'?t|not working|no power|nothing|dim|resets?|restarts?|randomly|garbage|nan|boot ?loops?|jitters?|hums?|dead|broken|fails?|failed|disconnects?|no light|smoke|burning|hot)\b/i;

function flash(panel) {
  if (reduceMotion()) return;
  panel.classList.remove("flash"); void panel.offsetWidth; panel.classList.add("flash");
}
function renderKnown() {
  roKnown.innerHTML = "";
  if (!diag.known.size) { roKnown.innerHTML = '<span class="chip chip-empty">—</span>'; return; }
  for (const k of diag.known) {
    const c = document.createElement("span"); c.className = "chip"; c.textContent = k;
    roKnown.appendChild(c);
    window.CM?.chipIn(c);
  }
}
function addKnown(label) {
  if (diag.known.has(label)) return;
  diag.known.add(label); renderKnown(); flash(roKnown.closest(".ro") ?? roKnown.parentElement);
}
function setVal(el, v, placeholder) {
  el.textContent = v || placeholder;
  el.classList.toggle("is-dim", !v);
  if (v) { flash(el.closest(".ro") ?? el.parentElement); window.CM?.valueIn(el); }
}
function renderProgress() {
  progFill.style.width = Math.round((diag.step / diag.total) * 100) + "%";
  progText.textContent = diag.step + " / " + diag.total;
  progFill.parentElement.setAttribute("aria-valuenow", String(diag.step));
}
function resetDiag() {
  diag.known.clear(); diag.unknown = diag.hypo = diag.next = null; diag.step = 0;
  renderKnown();
  setVal(roUnknown, null, "awaiting report");
  setVal(roHypo, null, "awaiting information");
  setVal(roNext, null, "press the core to open the channel");
  renderProgress();
}
function scanUserText(text) {
  for (const [re, label] of KNOWN_PATTERNS) if (re.test(text)) addKnown(label);
  if (!diag.unknown && SYMPTOM_RE.test(text)) {
    diag.unknown = text.length > 110 ? text.slice(0, 107) + "…" : text;
    setVal(roUnknown, diag.unknown, "");
  }
}

// ---- checklist (keyboard-accessible toggles) ----
function setChecklist(items) {
  checklistEl.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li"); li.className = "ck-empty dim"; li.textContent = "—";
    checklistEl.appendChild(li); return;
  }
  items.forEach((t, i) => {
    const li = document.createElement("li");
    li.tabIndex = 0; li.setAttribute("role", "checkbox"); li.setAttribute("aria-checked", "false");
    const idx = document.createElement("span"); idx.className = "ck-idx"; idx.textContent = String(i + 1).padStart(2, "0");
    const tx = document.createElement("span"); tx.className = "ck-txt"; tx.textContent = t;
    li.append(idx, tx);
    const toggle = () => { const done = li.classList.toggle("done"); li.setAttribute("aria-checked", String(done)); };
    li.onclick = toggle;
    li.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } };
    checklistEl.appendChild(li);
  });
}

// ---- tool bus + readout cards ----
function toolBusRow(name, status, info) {
  const idle = toolBusEl.querySelector(".tb-row.dim"); if (idle) idle.remove();
  const row = document.createElement("div"); row.className = "tb-row";
  const led = document.createElement("span"); led.className = "tb-led " + status;
  const nm = document.createElement("span"); nm.className = "tb-name"; nm.textContent = name;
  const inf = document.createElement("span"); inf.className = "tb-info"; inf.textContent = info;
  row.append(led, nm, inf);
  toolBusEl.prepend(row);
  while (toolBusEl.children.length > 9) toolBusEl.removeChild(toolBusEl.lastChild);
  return { led, inf };
}
function card(title, body, warn = false, kind = "info") {
  const ph = cardsEl.querySelector(".empty"); if (ph) ph.remove();
  const d = document.createElement("div");
  d.className = "ro-card " + (warn ? "warn" : kind);
  const h = document.createElement("h4"); h.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  d.append(h, pre);
  cardsEl.prepend(d);
  while (cardsEl.children.length > 12) cardsEl.removeChild(cardsEl.lastChild);
  window.CM?.cardIn(d);
}

// ---- Client-side tools (same KB as server; HTTP tools require public https hosts,
// so the localhost KB runs HERE via tool.call/tool.result). Only used when the
// session is configured inline (no stored agent); a stored agent brings its own. ----
const TOOLS = [
  { type: "function", name: "lookup_component", description: "Specs/pinouts/wiring for a part. Topics: arduino_uno, esp32, breadboard, led, gpio, sensors, motors, pwm, mqtt, code.", parameters: { type: "object", properties: { query: { type: "string", description: "e.g. esp32, led, pwm" } }, required: ["query"] } },
  { type: "function", name: "calc_circuit", description: "LED resistor / divider / ohms law math.", parameters: { type: "object", properties: { kind: { type: "string", enum: ["led_resistor", "divider", "ohms_law"] }, vsupply: { type: "number" }, vf: { type: "number" }, current_ma: { type: "number" } }, required: ["kind"] } },
  { type: "function", name: "debug_step", description: "Narrow a symptom to one next diagnostic question. Call for any not-working report.", parameters: { type: "object", properties: { symptom: { type: "string", description: "what user sees" } }, required: ["symptom"] } },
];
const INLINE_FALLBACK_PROMPT = "You are CircuitMate, a hands-free bench copilot for Arduino, ESP32, electronics, IoT and robotics builders. Speak AS CircuitMate TO the builder in 1-3 short sentences, never as the user. NEVER invent board model, voltage, LED type, wiring, resistor, pin, or supply. CLASSIFY THE USER'S MESSAGE FIRST and respond in the matching mode: 1. GENERAL KNOWLEDGE -- Answer directly and clearly. Never ask for a board or symptom. 2. CODING HELP -- Answer directly. Offer writing, explaining, or debugging code. When asked to write code, give a real, working sketch or snippet. 3. PROJECT / DESIGN -- Help design it. Ask only the genuinely needed details. 4. TROUBLESHOOTING -- Only for actual failure reports. 5. CALCULATION -- call calc_circuit when the user asks for a resistor or value and gives numbers. 6. OUT OF SCOPE -- Briefly redirect. Never automatically open with what board are you using? or what is the exact symptom?. If a request is ambiguous, ask one clarifying question instead of guessing; if you do not know, say so plainly. "

async function runToolLocal(name, args) {
  const tb = toolBusRow(name, "run", "…");
  const t0 = performance.now();
  let r, data;
  try {
    r = await fetch(`/api/tool/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args ?? {}) });
    data = await r.json();
  } catch {
    tb.led.className = "tb-led err"; tb.inf.textContent = "fetch failed";
    logErr("A diagnostic tool failed. Check your connection and try again.");
    return { error: "fetch failed" };
  }
  const ms = Math.max(1, Math.round(performance.now() - t0));
  tb.led.className = "tb-led " + (r.ok ? "ok" : "err");
  tb.inf.textContent = (r.ok ? "" : "HTTP " + r.status + " · ") + ms + "ms";

  if (name === "calc_circuit" && data.recommended_ohms) {
    card(`LED RESISTOR — USE ${data.recommended_ohms} Ω`, data, false, "ok");
    addKnown("LED"); addKnown("RESISTOR");
  } else if (name === "debug_step" && data.next_question) {
    card(`NEXT CHECK — ${data.next_question}`, data, !!data.safety);
    const hy = data.likely_causes ?? data.hypotheses ?? [];
    setChecklist([data.next_question, ...(data.follow_ups ?? []), ...hy.map((c) => `hypothesis: ${c}`)]);
    if (data.symptom) { diag.unknown = data.symptom; setVal(roUnknown, diag.unknown, ""); }
    diag.hypo = hy.length ? hy[0] : "narrowing — need one more answer";
    setVal(roHypo, diag.hypo, "");
    diag.next = data.next_question; setVal(roNext, diag.next, "");
    if (data.narrowed && diag.step < diag.total) { diag.step++; renderProgress(); }
    if (data.safety) card("SAFETY", data.safety, true, "warn");
  } else if (name === "lookup_component" && !data.error) {
    card(String(data.name ?? args.query ?? "COMPONENT").toUpperCase(), data);
    if (data.name) addKnown(String(data.name).split("(")[0].trim().toUpperCase());
  } else {
    card(`⇄ ${name}`, data, !!data.error, "warn");
  }
  return data;
}

async function flushToolsIfIdle() {
  if (lastEvent !== "reply.done" || pendingTools.length === 0 || !ws || ws.readyState !== 1) return;
  for (const t of pendingTools.splice(0)) {
    ws.send(JSON.stringify({ type: "tool.result", call_id: t.call_id, result: JSON.stringify(t.result) }));
  }
}

// ---- voice agent events → state machine + readouts ----
function onEvent(msg) {
  setTransport(FRIENDLY_EVENT[msg.type] ?? "channel update");
  switch (msg.type) {
    case "session.updated": break;
    case "session.ready":
      ready = true; sessionId = msg.session_id;
      sessionLabel.textContent = "CHANNEL OPEN";
      sessionLabel.classList.add("is-open");
      if (demoBanner) demoBanner.hidden = true;
      setState("LISTENING", "speak freely — interrupt anytime");
      log("sys", "Channel open — start speaking.");
      setButtons();
      break;
    case "input.speech.started":
      lastEvent = msg.type;
      if (uiState === "speaking") {
        // barge-in: user talked over the reply
        flushPlayback();
        setStateThen("INTERRUPTED", "barge-in — you cut in", "LISTENING", "speak — interrupt anytime", 900);
        log("sys", "↯ barge-in — playback flushed");
      } else {
        setState("LISTENING", "hearing you…");
      }
      break;
    case "transcript.user.delta":
      lastEvent = msg.type;
      if (!userRow) {
        userRow = mkRow("u"); userRow.row.classList.add("partial");
        setState("TRANSCRIBING", "capturing your turn…");
      }
      userRow.tx.textContent = msg.text; // full-so-far, replace not append
      break;
    case "input.speech.stopped":
      lastEvent = msg.type;
      thinkT0 = performance.now();
      setState("THINKING", "decoding turn…");
      break;
    case "transcript.user":
      if (userRow) { userRow.tx.textContent = msg.text; userRow.row.classList.remove("partial"); userRow = null; }
      else log("u", msg.text);
      scanUserText(msg.text);
      setState("THINKING", "reasoning…");
      break;
    case "reply.started":
      lastEvent = msg.type;
      replyT0 = performance.now();
      if (thinkT0) setTransport(`agent speaking… (${Math.round(replyT0 - thinkT0)}ms to respond)`);
      thinkT0 = 0;
      agentRow = mkRow("a"); agentRow.row.classList.add("partial");
      replyAudioCount = 0;
      setState("SPEAKING", "playing reply — talk to barge in");
      clearTimeout(replyWatchdog);
      replyWatchdog = setTimeout(() => {
        if (lastEvent === "reply.started" && replyAudioCount === 0) {
          logErr("agent started a reply but no audio arrived within 6s (check output device/volume).");
          setState("ERROR", "reply had no audio — see transcript");
        }
      }, 6000);
      break;
    case "reply.audio":
      if (replyAudioCount === 0 && replyT0) {
        setTransport(`agent speaking… (${Math.round(performance.now() - replyT0)}ms to first audio)`);
      }
      replyAudioCount++;
      playChunk(msg.data);
      break;
    case "transcript.agent.delta":
      if (agentRow) agentRow.tx.textContent += (msg.delta ?? "") + " ";
      break;
    case "transcript.agent":
      if (agentRow) {
        agentRow.tx.textContent = msg.text + (msg.interrupted ? " —" : "");
        agentRow.row.classList.remove("partial"); agentRow = null;
      } else log("a", msg.text);
      break;
    case "reply.done":
      lastEvent = msg.type;
      clearTimeout(replyWatchdog);
      if (msg.status === "interrupted") {
        flushPlayback();
        pendingTools = [];
        setStateThen("INTERRUPTED", "you cut in — listening", "LISTENING", "speak — interrupt anytime", 900);
      } else {
        if (replyAudioCount === 0) logErr("reply completed with zero audio chunks.");
        setState("LISTENING", "speak — interrupt anytime");
        flushToolsIfIdle();
      }
      break;
    case "tool.call":
      log("tool", `${msg.name} ${JSON.stringify(msg.arguments)}`);
      runToolLocal(msg.name, msg.arguments).then((result) => {
        pendingTools.push({ call_id: msg.call_id, result });
        flushToolsIfIdle(); // reply.done may already be the latest event
      });
      break;
    case "session.ended":
      cleanEnd = true;
      log("sys", `Session ended (${msg.session_duration_seconds ?? "?"}s on the bench).`);
      cleanup();
      setState("READY", "press the core to open the channel again");
      break;
    case "session.error":
    case "error":
      setState("ERROR", "the agent hit an error — press START to retry");
      logErr("The voice agent hit an error. Press START to retry.");
      setButtons();
      break;
    default:
      // Unknown events are ignored — the UI only reacts to known protocol events.
      break;
  }
}

// ---- playback: 24kHz PCM16 chunks; tap an analyser for the CH2 trace ----
// Single ordered queue: one absolute-time cursor, no overlaps. Chunks that
// arrive while the context is suspended (autoplay policy, backgrounded tab)
// would otherwise pile up on a frozen clock and then burst or drop.
function playChunk(b64data) {
  try {
    if (!audioCtx) return; // call already ended and cleaned up
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    if (typeof b64data !== "string" || b64data.length === 0) throw new Error("empty audio payload");
    const raw = atob(b64data);
    if (raw.length < 2 || raw.length % 2 !== 0) throw new Error("odd-length PCM payload");
    const pcm = new Int16Array(raw.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    const buf = audioCtx.createBuffer(1, f32.length, 24000); // context resamples on output
    buf.getChannelData(0).set(f32);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    if (agentAnalyser) src.connect(agentAnalyser);
    // Small lookahead so a late chunk never schedules in the past (overlap burst).
    const t = Math.max(playbackTime, audioCtx.currentTime + 0.03);
    src.start(t);
    playbackTime = t + buf.duration;
    src.onended = () => { const i = playSources.indexOf(src); if (i >= 0) playSources.splice(i, 1); };
    playSources.push(src);
    if (playSources.length > 64) playSources.splice(0, playSources.length - 64);
  } catch (e) {
    try { console.warn("[circuitmate] audio chunk failed:", e && e.message ? e.message : e); } catch {}
    logErr("Audio playback failed. Check your speakers or volume, then try again.");
  }
}
function flushPlayback() {
  for (const s of playSources) { try { s.stop(); } catch { /* already stopped */ } }
  playSources = [];
  if (audioCtx) playbackTime = audioCtx.currentTime;
}

// ---- error state: loud, specific, never a silent slide into mock ----
function enterError(what) {
  cleanup();
  setMode("error", "ERROR");
  const friendly = friendlyError(what);
  setState("ERROR", friendly.slice(0, 120));
  logErr(friendly);
  if (demoBanner && demoBannerText) {
    demoBannerText.textContent = "Live voice failed: " + friendly.slice(0, 160);
    demoBanner.hidden = false;
  }
}

async function startCall() {
  if (mode === "mock") { log("sys", "Demo mode is ON — press the core anyway to retry live (token is fetched again)."); }
  if (ws) return;
  abortStart = false;
  resetDiag();
  setState("CONNECTING", "fetching single-use token…");
  // 1. Fresh single-use token per connection (server holds the real key).
  let token = null;
  try {
    const r = await fetch("/api/voice-token");
    if (abortStart) return;
    if (!r.ok) {
      const body = (await r.text()).slice(0, 160);
      enterError(`token endpoint HTTP ${r.status}: ${body || "no detail"}. Server needs a valid ASSEMBLYAI_API_KEY.`);
      return;
    }
    token = (await r.json()).token;
  } catch (e) {
    if (abortStart) return;
    enterError("token request failed (server unreachable?): " + e.message);
    return;
  }
  if (abortStart) return;
  if (!token) { enterError("token endpoint returned no token."); return; }

  // 2. Mic with echo cancellation ON, noise suppression OFF (server denoises).
  try {
    audioCtx = new AudioContext(); // device rate; worklet resamples to 24k
    await audioCtx.resume();
    if (abortStart) { cleanup(); return; }
    await audioCtx.audioWorklet.addModule("/pcm-processor.js");
    if (abortStart) { cleanup(); return; }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
    if (abortStart) { cleanup(); return; }
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 512;
    micData = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    agentAnalyser = audioCtx.createAnalyser(); agentAnalyser.fftSize = 512;
    agentData = new Uint8Array(agentAnalyser.frequencyBinCount);
    worklet = new AudioWorkletNode(audioCtx, "pcm-processor", { processorOptions: { inputSampleRate: audioCtx.sampleRate, targetSampleRate: 24000 } });
    src.connect(worklet);
    // Keep the graph pulled without playing the mic back (silent sink).
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    worklet.connect(sink);
    sink.connect(audioCtx.destination);
    playbackTime = audioCtx.currentTime;
    worklet.port.onmessage = (e) => {
      if (ready && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "input.audio", audio: b64(e.data) }));
      }
    };
  } catch (e) {
    if (abortStart) return;
    enterError("mic blocked: " + e.message + " (need localhost/https + permission).");
    return;
  }

  // 3. WS with token only (no Authorization header in browser).
  if (abortStart) { cleanup(); return; }
  cleanEnd = false;
  const u = new URL(cfg.wsUrl);
  u.searchParams.set("token", token);
  ws = new WebSocket(u.toString());
  ws.onopen = () => {
    // Stored agent if published; else inline config so first run still talks.
    const session = cfg.agentId
      ? { agent_id: cfg.agentId }
      : { system_prompt: INLINE_FALLBACK_PROMPT, greeting: "Hey, CircuitMate here. Ask me anything -- electronics, code, a project, or something that's not working.", tools: TOOLS, input: { keyterms: ["Arduino", "ESP32", "breadboard", "GPIO", "PWM", "MQTT", "MOSFET", "resistor"] }, output: { voice: "alba" } };
    ws.send(JSON.stringify({ type: "session.update", session }));
  };
  ws.onmessage = (ev) => { try { onEvent(JSON.parse(ev.data)); } catch { logErr("The voice service sent an unexpected message. Try again."); } };
  ws.onclose = (ev) => {
    const wasClean = cleanEnd || ev.code === 1000;
    const hadSession = Boolean(sessionId);
    const wasLive = mode === "live";
    cleanup();
    if (wasClean) return;
    if (hadSession) {
      setState("ERROR", "connection dropped — press START to reconnect");
      logErr("The voice connection dropped. Press START to reconnect.");
    } else if (wasLive) {
      setState("ERROR", "couldn't open the voice connection");
      logErr("Couldn't open the voice connection. Check your network and try again.");
    }
  };
  ws.onerror = () => log("sys", "The voice connection hit an error. Try again — a fresh connection is created each time.");
}

function endCall() {
  if (ws && ws.readyState === 1) {
    cleanEnd = true;
    ws.send(JSON.stringify({ type: "session.end" })); // stops billing immediately; wait session.ended
    setState("THINKING", "closing channel…");
  } else cleanup();
}
function cleanup() {
  abortStart = true;
  clearTimeout(replyWatchdog);
  try { ws?.close(); } catch {}
  ws = null; ready = false; lastEvent = null; pendingTools = [];
  sessionId = null;
  userRow = agentRow = null;
  analyser = agentAnalyser = micData = agentData = null;
  micEnv = agentEnv = 0;
  micLevel.style.width = agentLevel.style.width = "0%";
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx?.close(); } catch {}
  micStream = worklet = audioCtx = null;
  sessionLabel.textContent = "STANDBY";
  sessionLabel.classList.remove("is-open");
  setState("READY", "press the core to open the channel");
}
window.addEventListener("pagehide", () => {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "session.end" })); } catch {}
  cleanup();
});
// A backgrounded tab suspends the AudioContext clock; resume on return so a
// reply in flight continues instead of piling up inaudibly and cutting off.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && audioCtx && audioCtx.state === "suspended" && (uiState === "speaking" || uiState === "thinking")) {
    audioCtx.resume().catch(() => {});
  }
});

// ---- explicit demo mode: via ?mock=1, the footer toggle, or a keyless server ----
function enterMock(reason) {
  cleanup();
  setMode("mock", "DEMO MODE");
  setState("READY", "offline demo — tools run locally");
  if (demoBanner) { if (demoBannerText) demoBannerText.textContent = "Voice engine offline — no ASSEMBLYAI_API_KEY on server. Diagnostic tools run locally; type below to drive them."; demoBanner.hidden = false; }
  log("sys", reason + " — everything you see from the tools is real local logic, but the voice agent is NOT connected.");
}
async function mockSend(text) {
  setState("THINKING", "demo reasoning…");
  const t = text.toLowerCase();
  // Route through the shared server intent classifier; fall back to the
  // previous local heuristic only if the endpoint is unreachable.
  let routed = null;
  try {
    const r = await fetch("/api/tool/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (r.ok) routed = await r.json();
  } catch {
    routed = null;
  }
  const intent = routed && typeof routed.intent === "string" ? routed.intent : null;
  const confidence = routed && typeof routed.confidence === "number" ? routed.confidence : 0;
  // Follow-up context: remember the last KB topic so a bare follow-up like
  // "what resistor should I use with 5V?" stays on the LED topic.
  let topic = routed && typeof routed.topic === "string" ? routed.topic : null;
  if (topic) {
    diag.lastTopic = topic;
  } else if ((intent === "calc" || intent === "knowledge") && diag.lastTopic) {
    topic = diag.lastTopic;
  }

  if (!intent || confidence < 0.7) {
    if (/\b(hello|hi|hey|thanks|thank you)\b/.test(t)) {
      log("a", "Hello! How can I help you today?", true);
    } else if (/resistor|ohm|divider/.test(t)) {
      const vs = (t.match(/(\d+(\.\d+)?)\s*v/) ?? [])[1];
      const ma = (t.match(/(\d+(\.\d+)?)\s*ma/) ?? [])[1];
      const white = /white|blue/.test(t);
      const res = await runToolLocal("calc_circuit", { kind: "led_resistor", vsupply: vs ? Number(vs) : 5, vf: white ? 3.2 : 2.0, current_ma: ma ? Number(ma) : 10 });
      if (res.recommended_ohms) log("a", `Use a ${res.recommended_ohms} Ω resistor. ${res.note}`, true);
      else log("a", res.error ?? "Can't compute that yet.", true);
    } else if (/lookup|pinout|spec|pwm|mqtt|esp32|arduino|breadboard|gpio|motor|sensor/.test(t)) {
      const m = t.match(/(arduino|esp32|breadboard|led|gpio|sensors?|motors?|pwm|mqtt|code)/);
      const alias = { sensor: "sensors", motor: "motors" };
      const res = await runToolLocal("lookup_component", { query: m ? (alias[m[1]] ?? m[1]) : "esp32" });
      log("a", `Check: ${(res.gotchas ?? res.rules ?? res.checklist ?? ["see tool readout →"])?.[0] ?? "see tool readout →"}`, true);
    } else {
      log("a", "I'm not sure how to respond to that — could you rephrase?", true);
    }
    setState("READY", "offline demo — type again, or toggle demo mode off to go live");
    return;
  }

  if (intent === "knowledge") {
    // KB-backed direct answer: look up the topic, then explain it plainly.
    const q = topic || "led";
    const info = await runToolLocal("lookup_component", { query: q });
    if (q === "led") {
      log("a", "An LED needs a series resistor to limit current and prevent it from burning out. The value is R = (Vs - Vf) / I — for example, a red LED at 5V and 10mA uses about 330 Ω.", true);
    } else if (q === "pwm") {
      log("a", "PWM means Pulse Width Modulation: rapidly switching a pin on and off to fake an analog level. On Arduino use analogWrite(pin, 0-255); on ESP32 use ledcAttach with a frequency around 5 kHz for LEDs.", true);
    } else if (q === "gpio") {
      log("a", "GPIO means General Purpose Input/Output: the pins your board uses to read sensors or drive outputs. Set pinMode explicitly, never short a driven pin, and keep one pin near 20 mA or less.", true);
    } else if (q === "esp32") {
      log("a", "ESP32 is a 3.3 V board with lots of GPIO plus Wi-Fi and Bluetooth. Watch the strapping pins 0, 2, 12 and 15 at boot, and give it solid USB power so it doesn't brown out.", true);
    } else if (q === "arduino_uno") {
      log("a", "Arduino Uno is a 5 V ATmega328P board: 14 digital pins (6 PWM) plus 6 analog inputs, about 20 mA per pin. Great starter board, but no Wi-Fi on its own.", true);
    } else {
      const first = info && (info.gotchas ?? info.rules ?? info.checklist ?? [])[0];
      log("a", first ? String(first) : "Here's what the knowledge base says — see the readout card for details.", true);
    }
    if (topic) diag.lastTopic = topic;
  } else if (intent === "coding") {
    const sketch = "const int ledPin = 13; void setup() { pinMode(ledPin, OUTPUT); } void loop() { digitalWrite(ledPin, HIGH); delay(500); digitalWrite(ledPin, LOW); delay(500); }";
    log("a", "I can write, explain, and debug Arduino and MicroPython code. Here's a basic LED blink sketch: " + sketch + " What would you like to build or fix?", true);
  } else if (intent === "project") {
    if (topic && topic !== "project") await runToolLocal("lookup_component", { query: topic });
    log("a", "I can help you design that. To size it right, tell me: which board, which sensor or actuator, and how you'll power it?", true);
  } else if (intent === "calc") {
    const vs = (t.match(/(\d+(\.\d+)?)\s*v/) ?? [])[1];
    const ma = (t.match(/(\d+(\.\d+)?)\s*ma/) ?? [])[1];
    const white = /white|blue/.test(t);
    const res = await runToolLocal("calc_circuit", { kind: "led_resistor", vsupply: vs ? Number(vs) : 5, vf: white ? 3.2 : 2.0, current_ma: ma ? Number(ma) : 10 });
    if (res.recommended_ohms) log("a", `Use a ${res.recommended_ohms} Ω resistor. ${res.note}`, true);
    else log("a", res.error ?? "Can't compute that yet.", true);
  } else if (intent === "troubleshooting") {
    const res = await runToolLocal("debug_step", { symptom: text });
    log("a", res.next_question ?? "What changed since it last worked?", true);
  } else {
    log("a", "CircuitMate helps with Arduino, ESP32, electronics, IoT, and embedded code. Ask me about a circuit, a sketch, a project, or something that's not working.", true);
  }
  setState("READY", "offline demo — type again, or toggle demo mode off to go live");
}
const b64 = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };

// ---- wiring ----
startBtn.onclick = startCall;
endBtn.onclick = endCall;
coreBtn.onclick = () => {
  if (ws && (ready || ws.readyState === 1)) endCall();
  else if (!startBtn.disabled) startCall();
};
interruptBtn.onclick = () => { flushPlayback(); log("sys", "Audio stopped — voice barge-in is automatic while the agent speaks."); };
$("mockToggle").onclick = toggleDemoMode;
function toggleDemoMode() {
  location.href = mode === "mock" ? location.pathname : location.pathname + "?mock=1";
}
$("textForm").onsubmit = async (e) => {
  e.preventDefault();
  const v = textInput.value.trim();
  if (!v) return;
  textInput.value = "";
  scanUserText(v);
  if (mode === "mock") { log("u", v); await mockSend(v); return; }
  if (ws && ready && ws.readyState === 1) {
    // Live typed turn: inject into conversation context, then ask for a spoken reply.
    log("u", v + "  (typed)");
    setState("THINKING", "reasoning…");
    ws.send(JSON.stringify({ type: "conversation.message", role: "user", content: v }));
    ws.send(JSON.stringify({ type: "reply.create", instructions: "Answer the builder's typed message as CircuitMate, speaking directly to them in 1-3 short sentences." }));
  } else {
    logErr("You're not connected yet. Press START CALL first.");
  }
};

// ---- boot ----
(async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has("mock")) { enterMock("explicit ?mock=1"); return; }
  try {
    cfg = await (await fetch("/api/config")).json();
  } catch (e) {
    enterError("could not reach /api/config — is the server running? (" + e.message + ")");
    return;
  }
  if (cfg.mock) { enterMock("no ASSEMBLYAI_API_KEY on the server"); return; }
  setMode("live", "LIVE · ASSEMBLYAI");
  log("sys", "Bench powered — AssemblyAI voice agent ready. Press the core and speak.");
  setState("READY", cfg.agentId ? "agent bound — press the core to talk" : "no AGENT_ID yet — inline config fallback");
})();







