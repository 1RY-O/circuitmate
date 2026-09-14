// Headless end-to-end check of the REAL AssemblyAI voice loop (no mic/browser needed).
// The stored agent has a greeting, so reply.audio arrives without any mic input.
// Client-side tools are executed against the LOCAL server (/api/tool/*), exactly
// like the browser does — start it first (`npm run dev`) for the full loop.
// Usage:
//   node scripts/voice-loop-check.mjs --with-tools   # A (bad shape) + B (good shape)
//   node scripts/voice-loop-check.mjs --only=C        # live-text injection + prompt assertions
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
if (!KEY || !AGENT_ID) {
  console.error("FAIL need ASSEMBLYAI_API_KEY + AGENT_ID in env/.env");
  process.exit(1);
}
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const withTools = process.argv.includes("--with-tools");
const TOOL_BASE = process.env.TOOL_BASE ?? "http://localhost:3000";

async function mintToken() {
  const u = new URL("https://agents.assemblyai.com/v1/token");
  u.searchParams.set("expires_in_seconds", "180");
  u.searchParams.set("max_session_duration_seconds", "600");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`token mint HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTool(name, args) {
  const r = await fetch(`${TOOL_BASE}/api/tool/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!r.ok) throw new Error(`local tool ${name} HTTP ${r.status}`);
  return r.json();
}

async function runSession(label, sessionPayload, script, windowMs = 16000) {
  console.log(`\n=== ${label} ===`);
  const token = await mintToken();
  const u = new URL("wss://agents.assemblyai.com/v1/ws");
  u.searchParams.set("token", token);
  const ws = new WebSocket(u.toString());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws open failed"));
  });
  const t0 = Date.now();
  const events = [];
  let audioChunks = 0;
  let lastType = null;
  let pending = [];
  const log = (s) => events.push(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);

  async function flush() {
    if (lastType !== "reply.done" || pending.length === 0 || ws.readyState !== 1) return;
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
    if (m.type === "transcript.agent") { log(`agent:\u201c${(m.text ?? "").slice(0, 220)}\u201d`); return; }
    if (m.type === "transcript.user") { log(`user:\u201c${(m.text ?? "").slice(0, 120)}\u201d`); return; }
    if (m.type === "session.error") { log(`session.error[${m.code}] ${(m.message ?? "").slice(0, 140)}`); return; }
    if (m.type === "tool.call") {
      log(`tool.call ${m.name} ${(JSON.stringify(m.arguments) ?? "").slice(0, 160)}`);
      runTool(m.name, m.arguments).then(
        async (result) => { pending.push({ call_id: m.call_id, result }); await flush(); },
        (e) => log(`local tool FAILED: ${e.message}`)
      );
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
  ws.send(JSON.stringify({ type: "session.update", session: sessionPayload }));

  const waitFor = async (pred, timeoutMs, what) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (events.some(pred)) return true;
      await sleep(250);
    }
    console.log(`  (waitFor timeout: ${what})`);
    return false;
  };
  if (script) await script({ ws, waitFor, sleep, events });
  const elapsed = Date.now() - t0;
  if (elapsed < windowMs) await sleep(windowMs - elapsed);
  try { ws.send(JSON.stringify({ type: "session.end" })); } catch {}
  await sleep(1200);
  try { ws.close(); } catch {}

  console.log(`audio chunks: ${audioChunks}`);
  for (const e of events) console.log(`  ${e}`);
  return { events, audioChunks };
}

let resB = { audioChunks: 0 };

if (withTools && (!only || only === "A")) {
  await runSession("A: agent_id + inline tools (old frontend shape)", {
    agent_id: AGENT_ID,
    tools: [{ type: "function", name: "ping", description: "test", parameters: { type: "object", properties: {} } }],
  });
}

if (!only || only === "B") {
  resB = await runSession("B: agent_id alone", { agent_id: AGENT_ID });
}

if (!only || only === "C") {
  const ledQuestion = "My Arduino LED isn't lighting up. Can you help me troubleshoot it?";
  const { events } = await runSession(
    "C: live text injection (LED question) + tool round-trip",
    { agent_id: AGENT_ID },
    async ({ ws, waitFor, events }) => {
      await waitFor((e) => e.includes("reply.done"), 15000, "greeting reply.done");
      const mark = events.length;
      ws.send(JSON.stringify({ type: "conversation.message", role: "user", content: ledQuestion }));
      ws.send(JSON.stringify({ type: "reply.create" }));
      console.log(`  injected at event #${mark}`);
      return { mark };
    },
    45000
  );
  const toolLine = events.find((e) => e.includes("tool.call debug_step")) ?? "";
  const verbatim = (toolLine.match(/symptom[^a-z0-9]{0,4}([^}]{10,})/i) ?? [])[1] ?? "";
  const agentLines = events.filter((e) => e.includes("agent:\u201c"));
  const answer = agentLines[agentLines.length - 1] ?? "";
  console.log(`\ntool got symptom text (${verbatim.length} chars): ${verbatim.length >= 10 ? "PASS" : "FAIL"} ${verbatim.slice(0, 80)}`);
  console.log(`answer asks a question: ${answer.includes("?") ? "PASS" : "FAIL"}`);
  console.log(`answer disambiguates built-in vs external: ${/built-in|breadboard|external/i.test(answer) ? "PASS" : "FAIL"}`);
  console.log(`answer states a resistor value unprompted: ${/[0-9]+\s*(Ω|ohm)/i.test(answer) ? "FAIL (assumption)" : "PASS"}`);
}

console.log("\n=== SUMMARY ===");
console.log(`B greeting audio: ${resB.audioChunks > 0 ? "PASS" : only && only !== "B" ? "skipped" : "FAIL"} (${resB.audioChunks} chunks)`);
