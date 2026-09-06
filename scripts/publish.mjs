// Publish CircuitMate stored agent: POST /v1/agents (or PUT if AGENT_ID exists).
// REST auth uses the BARE key (no Bearer prefix) — unlike the voice WS which uses Bearer.
// Usage: npm run publish   (reads src/agent/circuitmate.json, writes AGENT_ID into .env)
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const envPath = join(root, ".env");
const envExample = join(root, ".env.example");
if (!existsSync(envPath) && existsSync(envExample)) writeFileSync(envPath, readFileSync(envExample));

function loadEnv() {
  const out = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
function saveEnv(patch) {
  const env = loadEnv();
  Object.assign(env, patch);
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n");
}

const env = loadEnv();
const KEY = process.env.ASSEMBLYAI_API_KEY ?? env.ASSEMBLYAI_API_KEY ?? "";
if (!KEY) {
  console.error("Missing ASSEMBLYAI_API_KEY (env or .env). Get one at assemblyai.com/dashboard/api-keys");
  process.exit(1);
}
const agent = JSON.parse(readFileSync(join(root, "src", "agent", "circuitmate.json"), "utf8"));
const existing = process.env.AGENT_ID ?? env.AGENT_ID ?? "";

const url = existing ? `https://agents.assemblyai.com/v1/agents/${existing}` : "https://agents.assemblyai.com/v1/agents";
const res = await fetch(url, {
  method: existing ? "PUT" : "POST",
  headers: { Authorization: KEY, "Content-Type": "application/json" },
  body: JSON.stringify(agent),
});
const text = await res.text();
if (!res.ok) {
  console.error(`${existing ? "PUT" : "POST"} failed (${res.status}): ${text}`);
  process.exit(1);
}
const data = JSON.parse(text);
saveEnv({ AGENT_ID: data.id ?? existing });
console.log(`${existing ? "Updated" : "Published"} agent ${data.id ?? existing} (${agent.name})`);
