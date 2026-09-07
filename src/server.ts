import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKB, lookupComponent, calcCircuit, debugStep, checkSafety } from "./circuit-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pubDir = join(root, "public");

// Minimal .env loader (no dependency).
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile(join(process.cwd(), ".env"));
loadEnvFile(join(root, ".env"));

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.ASSEMBLYAI_API_KEY ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";
const TIMING = process.env.TIMING === "1";
const kb = loadKB();

// Tiny abuse guard for the token endpoint: single-use tokens are cheap to
// mint but each one can open a billed voice session, so cap mint rate.
const tokenHits: number[] = [];
function tokenRateLimited(): boolean {
  const now = Date.now();
  while (tokenHits.length > 0 && now - tokenHits[0] > 60_000) tokenHits.shift();
  if (tokenHits.length >= 12) return true;
  tokenHits.push(now);
  return false;
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 256 * 1024;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let bytes = 0;
    let s = "";
    let tooLarge = false;
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      s += c;
    });
    req.on("end", () => resolve(tooLarge ? null : s));
  });
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = join(pubDir, p);
  if (!file.startsWith(pubDir)) return false;
  try {
    const st = await stat(file);
    if (st.isDirectory()) return false;
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  // Never leak the key. Browser mints a short-lived single-use token instead.
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { agentId: AGENT_ID, mock: !API_KEY, wsUrl: "wss://agents.assemblyai.com/v1/ws" });
  }

  if (req.method === "GET" && url.pathname === "/api/voice-token") {
    if (!API_KEY) return json(res, 503, { error: "No ASSEMBLYAI_API_KEY on server (mock mode).", mock: true });
    if (tokenRateLimited()) return json(res, 429, { error: "token rate limit: max 12 mints per minute." });
    try {
      const t = new URL("https://agents.assemblyai.com/v1/token");
      t.searchParams.set("expires_in_seconds", "120");
      t.searchParams.set("max_session_duration_seconds", "1800");
      const r = await fetch(t, { headers: { Authorization: `Bearer ${API_KEY}` } });
      if (!r.ok) return json(res, r.status, { error: await r.text() });
      const data = (await r.json()) as { token: string };
      return json(res, 200, { token: data.token });
    } catch (e) {
      return json(res, 502, { error: String(e) });
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/knowledge/")) {
    const name = url.pathname.split("/").pop() ?? "";
    const map: Record<string, unknown> = { components: kb.components, faults: kb.faults, safety: kb.safety };
    if (!(name in map)) return json(res, 404, { error: `unknown knowledge set '${name}'` });
    return json(res, 200, map[name]);
  }

  // Local tool execution for UI fallback tests + debugging without voice.
  if (req.method === "POST" && url.pathname.startsWith("/api/tool/")) {
    const name = url.pathname.split("/").pop() ?? "";
    const raw = await readBody(req);
    if (raw === null) return json(res, 413, { error: "body too large (max 256KB)" });
    let args: any = {};
    try {
      args = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    const t0 = Date.now();
    const finish = (status: number, body: unknown) => {
      if (TIMING) console.log(`[timing] tool/${name} ${Date.now() - t0}ms -> ${status}`);
      return json(res, status, body);
    };
    if (name === "lookup_component") return finish(200, lookupComponent(kb, String(args.query ?? "")));
    if (name === "calc_circuit") {
      for (const k of ["vsupply", "vf", "current_ma"] as const) {
        if (args[k] !== undefined && !isFiniteNumber(args[k])) {
          return finish(400, { error: `'${k}' must be a number` });
        }
      }
      return finish(200, calcCircuit(args));
    }
    if (name === "debug_step") {
      const out = debugStep(kb, String(args.symptom ?? "")) as Record<string, unknown>;
      const warn = checkSafety(kb, String(args.symptom ?? ""));
      if (warn) out.safety = warn;
      return finish(200, out);
    }
    return finish(404, { error: `unknown tool '${name}'` });
  }

  if (req.method === "GET" && (url.pathname === "/api/agent" || url.pathname === "/api/health")) {
    return json(res, 200, { ok: true, mock: !API_KEY, agentConfigured: Boolean(AGENT_ID) });
  }

  if (req.method === "GET") {
    if (await serveStatic(req, res)) return;
    // SPA fallback for deep links (but keep /api 404s as JSON).
    if (!url.pathname.startsWith("/api")) {
      try {
        const data = await readFile(join(pubDir, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
        return;
      } catch {
        // fall through to 404
      }
    }
  }
  return json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`CircuitMate bench server on http://localhost:${PORT} ${API_KEY ? "(live voice)" : "(MOCK — set ASSEMBLYAI_API_KEY for live voice)"}`);
});
