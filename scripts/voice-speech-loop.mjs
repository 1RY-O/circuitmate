// Full speech-in/speech-out loop test using SAPI-rendered WAVs (no mic needed).
// Prereqs: server running (`npm run dev`), WAVs at the paths below (24kHz PCM16 mono).
// Usage: node scripts/voice-speech-loop.mjs
// NEVER prints the API key or token (lengths only).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const env = {};
if (existsSync(join(root, ".env"))) {
  for (const l of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
const KEY = process.env.ASSEMBLYAI_API_KEY ?? env.ASSEMBLYAI_API_KEY ?? "";
const AGENT_ID = process.env.AGENT_ID ?? env.AGENT_ID ?? "";
const TOOL_BASE = process.env.TOOL_BASE ?? "http://localhost:3000";
const TMP = process.env.TMP_WAV_DIR ?? "C:\\Users\\ASUS\\AppData\\Local\\Temp\\opencode";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPCM24kMono16(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file: " + path);
  }
  let off = 12;
  let fmt = null;
  let pcm = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = { audio: buf.readUInt16LE(off + 8), ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === "data") {
      pcm = buf.subarray(off + 8, off + 8 + size);
      break;
    }
    off += 8 + size;
  }
  console.log(`wav: ${fmt.ch}ch ${fmt.rate}Hz ${fmt.bits}bit, ${(pcm.length / 2 / fmt.rate).toFixed(1)}s audio`);
  if (fmt.audio !== 1 || fmt.ch !== 1 || fmt.bits !== 16) throw new Error("need PCM16 mono, got " + JSON.stringify(fmt));
  if (fmt.rate !== 24000) throw new Error("need 24kHz (render with SpeechAudioFormatInfo 24k)");
  return pcm;
}

async function main() {
  const health = await fetch(`${TOOL_BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error("local server not running — start `npm run dev` first");
  if (health.mock) throw new Error("server is in mock mode (no key) — live test needs the key");

  const tu = new URL("https://agents.assemblyai.com/v1/token");
  tu.searchParams.set("expires_in_seconds", "240");
  tu.searchParams.set("max_session_duration_seconds", "600");
  const tr = await fetch(tu, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!tr.ok) throw new Error(`token HTTP ${tr.status}`);
  const token = (await tr.json()).token;

  const u = new URL("wss://agents.assemblyai.com/v1/ws");
  u.searchParams.set("token", token);
  const ws = new WebSocket(u.toString());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open")); });
  const t0 = Date.now();
  const events = [];
  let audioChunks = 0;
  let lastType = null;
  let pending = [];
  const log = (s) => events.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
  async function flush() {
    if (lastType !== "reply.done" || !pending.length || ws.readyState !== 1) return;
    for (const t of pending.splice(0)) {
      ws.send(JSON.stringify({ type: "tool.result", call_id: t.call_id, result: JSON.stringify(t.result) }));
      log(`tool.result ${t.call_id} ok`);
    }
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data.toString());
    lastType = m.type;
    if (m.type === "reply.audio") { audioChunks++; return; }
    if (m.type === "transcript.agent.delta") return;
    if (m.type === "transcript.agent") return void log(`agent:\u201c${(m.text ?? "").slice(0, 220)}\u201d`);
    if (m.type === "transcript.user") return void log(`user/heard:\u201c${m.text}\u201d`);
    if (m.type === "session.error") return void log(`session.error[${m.code}] ${(m.message ?? "").slice(0, 120)}`);
    if (m.type === "tool.call") {
      log(`tool.call ${m.name} ${(JSON.stringify(m.arguments) ?? "").slice(0, 160)}`);
      fetch(`${TOOL_BASE}/api/tool/${m.name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m.arguments ?? {}) })
        .then((r) => r.json())
        .then(async (result) => { pending.push({ call_id: m.call_id, result }); await flush(); })
        .catch((e) => log("local tool FAILED: " + e.message));
      return;
    }
    if (m.type === "reply.done") {
      log(`reply.done status=${m.status}`);
      if (m.status === "interrupted") pending = [];
      else flush();
      return;
    }
    log(m.type);
  };
  ws.onclose = (ev) => log(`CLOSE code=${ev.code}`);
  ws.send(JSON.stringify({ type: "session.update", session: { agent_id: AGENT_ID } }));

  const waitFor = async (pred, timeoutMs, what) => {
    const s = Date.now();
    while (Date.now() - s < timeoutMs) {
      if (events.some(pred)) return true;
      await sleep(250);
    }
    console.log(`  (waitFor timeout: ${what})`);
    return false;
  };

  console.log("waiting for greeting…");
  await waitFor((e) => e.includes("reply.done"), 15000, "greeting");

  async function speakTurn(path, label) {
    const pcm = loadPCM24kMono16(path);
    const mark = events.length;
    console.log(`${label}: streaming ${(pcm.length / 4800).toFixed(0)} chunks…`);
    const per = 4800; // 50ms @24k mono16
    for (let o = 0; o < pcm.length; o += per) {
      if (ws.readyState !== 1) throw new Error("socket died mid-turn");
      ws.send(JSON.stringify({ type: "input.audio", audio: Buffer.from(pcm.subarray(o, o + per)).toString("base64") }));
      await sleep(50);
    }
    console.log(`${label}: stream done, waiting for turn…`);
    await waitFor((e) => events.indexOf(e) >= mark && e.includes("user/heard:"), 25000, label + " transcript");
    // NOTE: with tools, the first reply.done only closes the tool-call turn;
    // the spoken answer (transcript.agent) follows the tool.result round-trip.
    await waitFor((e) => events.indexOf(e) >= mark && e.includes("agent:\u201c"), 45000, label + " answer");
    await waitFor((e) => events.indexOf(e) >= mark && e.includes("reply.done"), 20000, label + " reply.done");
    return mark;
  }

  const m1 = await speakTurn(`${TMP}\\turn1.wav`, "TURN1");
  const answers1 = events.slice(m1).filter((e) => e.includes("agent:\u201c"));
  // If the agent asks a question, answer it with turn 2 (tests conversation context).
  let m2 = -1;
  if (answers1.length && answers1[answers1.length - 1].includes("?")) {
    await sleep(1000);
    m2 = await speakTurn(`${TMP}\\turn2.wav`, "TURN2");
  }

  try { ws.send(JSON.stringify({ type: "session.end" })); } catch {}
  await sleep(1500);
  try { ws.close(); } catch {}

  console.log("\n--- events ---");
  for (const e of events) console.log("  " + e);
  const heard = events.filter((e) => e.includes("user/heard:"));
  const tools = events.filter((e) => e.includes("tool.call"));
  const answers = events.filter((e) => e.includes("agent:\u201c"));
  const lastAnswer = answers[answers.length - 1] ?? "";
  console.log("\n--- assertions ---");
  console.log(`STT transcribed speech turns: ${heard.length >= (m2 >= 0 ? 2 : 1) ? "PASS" : "FAIL"} (${heard.length})`);
  console.log(`tool call made: ${tools.length ? "PASS" : "FAIL"} (${tools.map((t) => t.split("tool.call ")[1].split(" ")[0]).join(",")})`);
  console.log(`final answer asks/continues (has ? or next action): ${/[?]|next|check|measure|tell me/i.test(lastAnswer) ? "PASS" : "FAIL"}`);
  console.log(`final answer states ohms unprompted: ${/[0-9]+\s*(Ω|ohm)/i.test(lastAnswer) && !/assum/i.test(lastAnswer) ? "FAIL" : "PASS"}`);
  console.log(`downlink audio chunks: ${audioChunks > 0 ? "PASS" : "FAIL"} (${audioChunks})`);
}

main().catch((e) => { console.error("FATAL " + e.message); process.exit(1); });
