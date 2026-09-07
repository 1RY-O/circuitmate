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
const coreBtn = $("coreBtn"), coreLabel = $("coreLabel"), mockBtn = $("mockBtn");
const transportLog = $("transportLog");
const roKnown = $("roKnown"), roUnknown = $("roUnknown"), roHypo = $("roHypo"), roNext = $("roNext");
const progFill = $("progFill"), progText = $("progText");
const scope = $("scope"), textInput = $("textInput");
const sctx = scope.getContext("2d");

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  if (mockBtn) {
    mockBtn.textContent = m === "mock" ? "GO LIVE" : "OFFLINE";
    mockBtn.title = m === "mock"
      ? "Leave demo mode and retry the live voice agent"
      : "Explicit offline tool test — never automatic";
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

function rms(data) {
  let s = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; s += v * v; }
  return Math.sqrt(s / data.length);
}
function drawTrace(data, color, gain) {
  const n = data.length;
  sctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * scopeW;
    const y = scopeH / 2 - ((data[i] - 128) / 128) * (scopeH / 2) * gain;
    i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
  }
  sctx.strokeStyle = color;
  sctx.lineWidth = Math.max(1, scopeH / 240);
  sctx.shadowColor = color; // phosphor glow
  sctx.shadowBlur = reduceMotion ? 0 : 7;
  sctx.stroke();
  sctx.shadowBlur = 0;
}

function drawScope(ts) {
  requestAnimationFrame(drawScope);
  if (!scopeW) return;
  if (reduceMotion && ts - lastFrame < 220) return;
  lastFrame = ts;
  const w = scopeW, h = scopeH, mid = h / 2;

  // smoothed envelopes drive meters, channel LEDs and core pulse
  let micRms = 0, agentRms = 0;
  if (analyser && micData) { analyser.getByteTimeDomainData(micData); micRms = rms(micData); }
  if (agentAnalyser && agentData) { agentAnalyser.getByteTimeDomainData(agentData); agentRms = rms(agentData); }
  micEnv = Math.max(micRms, micEnv * 0.88);
  agentEnv = Math.max(agentRms, agentEnv * 0.86);
  document.documentElement.style.setProperty("--core-env",
    (uiState === "listening" ? micEnv : uiState === "speaking" ? agentEnv : 0).toFixed(3));
  micLevel.style.width = Math.min(100, micEnv * 260) + "%";
  agentLevel.style.width = Math.min(100, agentEnv * 260) + "%";
  chIn.classList.toggle("active", micRms > 0.02);
  chOut.classList.toggle("active", agentRms > 0.02);

  // graticule
  sctx.clearRect(0, 0, w, h);
  sctx.strokeStyle = "rgba(96,130,170,0.09)";
  sctx.lineWidth = 1;
  sctx.beginPath();
  for (let i = 1; i < 12; i++) { const x = Math.round((i / 12) * w) + 0.5; sctx.moveTo(x, 0); sctx.lineTo(x, h); }
  for (let j = 1; j < 4; j++) { const y = Math.round((j / 4) * h) + 0.5; sctx.moveTo(0, y); sctx.lineTo(w, y); }
  sctx.stroke();
  sctx.strokeStyle = "rgba(96,130,170,0.18)";
  sctx.beginPath(); sctx.moveTo(0, mid + 0.5); sctx.lineTo(w, mid + 0.5); sctx.stroke();

  const stateColor = getComputedStyle(document.body).getPropertyValue("--state").trim() || "#64748b";

  if (analyser && micData && micRms > 0.004) drawTrace(micData, "rgba(74,222,128,0.9)", 1.15);
  if (agentAnalyser && agentData && agentRms > 0.004) drawTrace(agentData, "rgba(251,191,36,0.9)", 1.15);

  // idle: state-colored baseline + slow sweep
  if (micRms <= 0.004 && agentRms <= 0.004) {
    sctx.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const y = mid + Math.sin(x * 0.045 + ts * 0.0022) * (reduceMotion ? 0 : 1.6);
      x ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
    }
    sctx.strokeStyle = stateColor;
    sctx.globalAlpha = 0.55;
    sctx.lineWidth = 1.2;
    sctx.stroke();
    sctx.globalAlpha = 1;
    if (!reduceMotion) {
      const sx = ((ts / 7000) % 1) * w;
      const grad = sctx.createLinearGradient(sx - 40, 0, sx, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(1, stateColor);
      sctx.globalAlpha = 0.28;
      sctx.strokeStyle = grad;
      sctx.beginPath(); sctx.moveTo(sx - 40, 0); sctx.lineTo(sx, h); sctx.stroke();
      sctx.globalAlpha = 1;
    }
  }
}
requestAnimationFrame(drawScope);

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
const diag = { known: new Set(), unknown: null, hypo: null, next: null, step: 0, total: 4 };
const KNOWN_PATTERNS = [
  [/\barduino\s*(uno)?\b/i, "ARDUINO UNO"], [/\besp32\b/i, "ESP32"],
  [/\braspberry\s*pi\b/i, "RASPBERRY PI"], [/\bbreadboard\b/i, "BREADBOARD"],
  [/\bled(s)?\b/i, "LED"], [/\bservo\b/i, "SERVO"], [/\bmotors?\b/i, "MOTOR"],
  [/\bdht\s*22?\b/i, "DHT22"], [/\bhc[-\s]?sr04\b|ultrasonic/i, "HC-SR04"],
  [/\bmqtt\b/i, "MQTT"], [/\bresistors?\b/i, "RESISTOR"],
];
const SYMPTOM_RE = /\b(won'?t|wouldn'?t|doesn'?t|not working|no power|nothing|dim|resets?|restarts?|randomly|garbage|nan|boot ?loops?|jitters?|hums?|dead|broken|fails?|failed|disconnects?|no light|smoke|burning|hot)\b/i;

function flash(panel) {
  if (reduceMotion) return;
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
const INLINE_FALLBACK_PROMPT = "You are CircuitMate, a hands-free bench copilot for Arduino, ESP32, electronics, IoT and robotics builders. Speak AS CircuitMate TO the builder in 1-3 short sentences, never as the user. NEVER invent board model, voltage, LED type, wiring, resistor, pin, or supply — ask exactly ONE question that splits the likely causes. Prefer calling lookup_component/calc_circuit/debug_step over guessing; call calc_circuit only when supply, load and current are known.";

async function runToolLocal(name, args) {
  const tb = toolBusRow(name, "run", "…");
  const t0 = performance.now();
  let r, data;
  try {
    r = await fetch(`/api/tool/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args ?? {}) });
    data = await r.json();
  } catch (e) {
    tb.led.className = "tb-led err"; tb.inf.textContent = "fetch failed";
    logErr(`tool ${name} failed: ${e.message}`);
    return { error: e.message };
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
  transportLog.textContent = msg.type;
  switch (msg.type) {
    case "session.updated": break;
    case "session.ready":
      ready = true; sessionId = msg.session_id;
      sessionLabel.textContent = "SESSION " + String(sessionId).slice(0, 8);
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
      if (thinkT0) transportLog.textContent += ` (+${Math.round(replyT0 - thinkT0)}ms since speech end)`;
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
        transportLog.textContent = `reply.audio (+${Math.round(performance.now() - replyT0)}ms since reply start)`;
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
      setState("ERROR", "agent error — START retries");
      logErr(`${msg.code ?? ""} ${msg.message ?? JSON.stringify(msg)}`.trim());
      setButtons();
      break;
    default:
      log("sys", "event: " + msg.type);
  }
}

// ---- playback: 24kHz PCM16 chunks; tap an analyser for the CH2 trace ----
function playChunk(b64data) {
  try {
    if (typeof b64data !== "string" || b64data.length === 0) throw new Error("empty audio payload");
    const raw = atob(b64data);
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
    playbackTime = Math.max(playbackTime, audioCtx.currentTime);
    src.start(playbackTime);
    playbackTime += buf.duration;
    playSources.push(src);
    if (playSources.length > 64) playSources.splice(0, playSources.length - 64);
  } catch (e) {
    logErr("audio playback failed: " + e.message);
  }
}
function flushPlayback() {
  for (const s of playSources) { try { s.stop(); } catch {} }
  playSources = [];
  if (audioCtx) playbackTime = audioCtx.currentTime;
}

// ---- error state: loud, specific, never a silent slide into mock ----
function enterError(what) {
  cleanup();
  setMode("error", "ERROR");
  setState("ERROR", what.slice(0, 80));
  logErr(what);
  if (demoBanner && demoBannerText) {
    demoBannerText.textContent = "Live voice failed: " + what.slice(0, 160);
    demoBanner.hidden = false;
  }
}

async function startCall() {
  if (mode === "mock") { log("sys", "Demo mode is ON — press the core anyway to retry live (token is fetched again)."); }
  if (ws) return;
  resetDiag();
  setState("CONNECTING", "fetching single-use token…");
  // 1. Fresh single-use token per connection (server holds the real key).
  let token = null;
  try {
    const r = await fetch("/api/voice-token");
    if (!r.ok) {
      const body = (await r.text()).slice(0, 160);
      enterError(`token endpoint HTTP ${r.status}: ${body || "no detail"}. Server needs a valid ASSEMBLYAI_API_KEY.`);
      return;
    }
    token = (await r.json()).token;
  } catch (e) {
    enterError("token request failed (server unreachable?): " + e.message);
    return;
  }
  if (!token) { enterError("token endpoint returned no token."); return; }

  // 2. Mic with echo cancellation ON, noise suppression OFF (server denoises).
  try {
    audioCtx = new AudioContext(); // device rate; worklet resamples to 24k
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule("/pcm-processor.js");
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
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
    enterError("mic blocked: " + e.message + " (need localhost/https + permission).");
    return;
  }

  // 3. WS with token only (no Authorization header in browser).
  cleanEnd = false;
  const u = new URL(cfg.wsUrl);
  u.searchParams.set("token", token);
  ws = new WebSocket(u.toString());
  ws.onopen = () => {
    // Stored agent if published; else inline config so first run still talks.
    const session = cfg.agentId
      ? { agent_id: cfg.agentId }
      : { system_prompt: INLINE_FALLBACK_PROMPT, greeting: "Hey, CircuitMate here. What are you building?", tools: TOOLS, input: { keyterms: ["Arduino", "ESP32", "breadboard", "GPIO", "PWM", "MQTT", "MOSFET", "resistor"] }, output: { voice: "alba" } };
    ws.send(JSON.stringify({ type: "session.update", session }));
  };
  ws.onmessage = (ev) => { try { onEvent(JSON.parse(ev.data)); } catch (e) { logErr("bad server frame: " + e.message); } };
  ws.onclose = (ev) => {
    ready = false;
    setButtons();
    if (cleanEnd || ev.code === 1000) return; // deliberate end / session.ended
    if (sessionId) {
      setState("ERROR", `socket closed (${ev.code}) — START resumes within 30s`);
      logErr(`socket closed code=${ev.code}. ` + (ev.code === 1006
        ? "Dropped before handshake: bad/expired single-use token, network, or mixed-content block. START fetches a fresh token."
        : "Press START to resume within the 30s grace window."));
    } else if (mode === "live") {
      setState("ERROR", `connect failed (${ev.code}) — see transcript`);
      logErr(`socket closed code=${ev.code} before session.ready. Token failures surface here as 1006 — check /api/voice-token.`);
    }
  };
  ws.onerror = () => log("sys", "WebSocket error (tokens are single-use — a stale token is the usual cause).");
}

function endCall() {
  if (ws && ws.readyState === 1) {
    cleanEnd = true;
    ws.send(JSON.stringify({ type: "session.end" })); // stops billing immediately; wait session.ended
    setState("THINKING", "closing channel…");
  } else cleanup();
}
function cleanup() {
  clearTimeout(replyWatchdog);
  try { ws?.close(); } catch {}
  ws = null; ready = false; lastEvent = null; pendingTools = [];
  userRow = agentRow = null;
  analyser = agentAnalyser = micData = agentData = null;
  micEnv = agentEnv = 0;
  micLevel.style.width = agentLevel.style.width = "0%";
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx?.close(); } catch {}
  micStream = worklet = audioCtx = null;
  setButtons();
}
window.addEventListener("pagehide", () => {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "session.end" })); } catch {}
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
  const symptomLike = /won'?t|not working|doesn'?t|can'?t|help|troubleshoot|dim|dead|reset|nan|fail|broken|wrong|issue|problem/.test(t);
  const wantsCalc = /resistor|ohm|divider/.test(t);
  if (wantsCalc) {
    const vs = (t.match(/(\d+(\.\d+)?)\s*v/) ?? [])[1];
    const ma = (t.match(/(\d+(\.\d+)?)\s*ma/) ?? [])[1];
    const white = /white|blue/.test(t);
    const res = await runToolLocal("calc_circuit", { kind: "led_resistor", vsupply: vs ? Number(vs) : 5, vf: white ? 3.2 : 2.0, current_ma: ma ? Number(ma) : 10 });
    if (res.recommended_ohms) log("a", `Use a ${res.recommended_ohms}Ω resistor. ${res.note}`, true);
    else log("a", res.error ?? "Can't compute that yet.", true);
  } else if (!symptomLike && /lookup|pinout|spec|pwm|mqtt|esp32|arduino|breadboard|gpio|motor|sensor/.test(t)) {
    const m = t.match(/(arduino|esp32|breadboard|led|gpio|sensors?|motors?|pwm|mqtt|code)/);
    const alias = { sensor: "sensors", motor: "motors" };
    const res = await runToolLocal("lookup_component", { query: m ? (alias[m[1]] ?? m[1]) : "esp32" });
    log("a", `Check: ${(res.gotchas ?? res.rules ?? res.checklist ?? ["see tool readout →"])?.[0] ?? "see tool readout →"}`, true);
  } else {
    const res = await runToolLocal("debug_step", { symptom: text });
    log("a", res.next_question ?? "What changed since it last worked?", true);
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
interruptBtn.onclick = () => { flushPlayback(); log("sys", "Playback flushed (voice barge-in is automatic while the agent speaks)."); };
$("mockToggle").onclick = toggleDemoMode;
if (mockBtn) mockBtn.onclick = toggleDemoMode;
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
    logErr("not connected — press START CALL first (typed text only works inside a live session).");
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







