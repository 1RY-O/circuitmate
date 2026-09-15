import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKB, lookupComponent, calcCircuit, debugStep, checkSafety } from "./circuit-tools.js";
import { FixedWindowLimiter } from "./rate-limit.js";
import { Logger, logLevelFromEnv } from "./logger.js";
import { makeMintToken, MintError, safeMintMessage } from "./voice-token.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pubDir = join(root, "public");

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

const MAX_BODY_BYTES = 256 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://agents.assemblyai.com wss://agents.assemblyai.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": CSP,
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export type MintToken = () => Promise<{ token: string }>;

export type AppDeps = {
  logger?: Logger;
  mintToken?: MintToken;
  apiKey?: string;
  agentId?: string;
  tokenIpLimit?: number;
  tokenGlobalLimit?: number;
  toolIpLimit?: number;
  toolGlobalLimit?: number;
};

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string") {
      const first = fwd.split(",")[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readBody(req: IncomingMessage): Promise<{ text: string } | { overflow: true } | { aborted: true }> {
  return new Promise((resolve) => {
    const cl = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(cl) && cl > 0 && cl > MAX_BODY_BYTES) {
      req.resume();
      return resolve({ overflow: true });
    }
    let bytes = 0;
    let tooLarge = false;
    let s = "";
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      s += c;
    });
    req.on("aborted", () => resolve({ aborted: true }));
    req.on("error", () => resolve({ aborted: true }));
    req.on("end", () => resolve(tooLarge ? { overflow: true } : { text: s }));
  });
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pub: string,
): Promise<boolean> {
  const p = ((req as { decodedPathname?: string }).decodedPathname ?? "").replace(/\/+$/, "") || "/";
  if (p.includes("\0")) return false;
  const file = join(pub, p);
  const rel = relative(pub, file);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") return false;
  try {
    const st = await stat(file);
    if (st.isDirectory()) return false;
    const headers = {
      ...BASE_HEADERS,
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": String(st.size),
    };
    res.writeHead(200, headers);
    if (req.method !== "HEAD") res.end(await readFile(file));
    else res.end();
    return true;
  } catch {
    return false;
  }
}

async function serveIndex(res: ServerResponse): Promise<void> {
  const data = await readFile(join(pubDir, "index.html"));
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(data);
}

export function createApp(deps: AppDeps = {}) {
  const logger = deps.logger ?? new Logger(logLevelFromEnv(process.env.LOG_LEVEL));
  const apiKey = deps.apiKey ?? process.env.ASSEMBLYAI_API_KEY ?? "";
  const agentId = deps.agentId ?? process.env.AGENT_ID ?? "";
  const trustProxy = (process.env.TRUST_PROXY ?? "").toUpperCase() === "1";
  const timing = process.env.TIMING === "1";
  const kb = loadKB();
  const mintToken = deps.mintToken ?? makeMintToken(apiKey);

  const tokenIpLimit = new FixedWindowLimiter(deps.tokenIpLimit ?? 6, 60_000);
  const tokenGlobalLimit = new FixedWindowLimiter(deps.tokenGlobalLimit ?? 24, 60_000);
  const toolIpLimit = new FixedWindowLimiter(deps.toolIpLimit ?? 120, 60_000);
  const toolGlobalLimit = new FixedWindowLimiter(deps.toolGlobalLimit ?? 600, 60_000);

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const urlPath = req.url ?? "/";
    const logAccess = (status: number) => {
      if (urlPath.startsWith("/api")) {
        logger.access({ ip: clientIp(req, trustProxy), method: req.method, path: urlPath, status, ms: Date.now() - t0 });
      }
    };
    req.on("error", () => {
      logger.debug({ event: "request_error", ip: clientIp(req, trustProxy) });
    });

    let parsed: URL;
    try {
      parsed = new URL(urlPath, "http://localhost");
    } catch {
      json(res, 400, { error: "invalid request" });
      logAccess(400);
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      json(res, 400, { error: "invalid request" });
      logAccess(400);
      return;
    }
    if (pathname.includes("\0")) {
      json(res, 400, { error: "invalid request" });
      logAccess(400);
      return;
    }
    if (pathname.split("/").includes("..")) {
      json(res, 404, { error: "not found" });
      logAccess(404);
      return;
    }
    (req as { decodedPathname?: string }).decodedPathname = pathname;

    try {
      if (req.method === "GET" && pathname === "/api/config") {
        json(res, 200, { agentId, mock: !apiKey, wsUrl: "wss://agents.assemblyai.com/v1/ws" });
        logAccess(200);
        return;
      }

      if (req.method === "GET" && pathname === "/api/voice-token") {
        if (parsed.search && parsed.search.length > 0) {
          json(res, 400, { error: "token parameters are fixed server-side; query strings are not accepted." });
          logAccess(400);
          return;
        }
        if (!apiKey) {
          json(res, 503, { error: "No ASSEMBLYAI_API_KEY on server (mock mode).", mock: true });
          logAccess(503);
          return;
        }
        const ip = clientIp(req, trustProxy);
        if (!tokenIpLimit.hit(ip) || !tokenGlobalLimit.hit("__global__")) {
          json(res, 429, { error: "Too many token requests from this client. Wait a minute and try again." }, { "Retry-After": "60" });
          logAccess(429);
          return;
        }
        try {
          const { token } = await mintToken();
          logger.info({ event: "token.issued", ip });
          json(res, 200, { token });
          logAccess(200);
        } catch (err) {
          const detail = err instanceof MintError
            ? { category: err.category, upstream: err.upstreamStatus }
            : { category: "unexpected" };
          logger.warn({ event: "token.mint_failed", ip, ...detail });
          const message = err instanceof MintError ? safeMintMessage(err) : "Voice agent token could not be issued. Please try again.";
          json(res, 502, { error: message });
          logAccess(502);
        }
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/knowledge/")) {
        const name = pathname.slice("/api/knowledge/".length);
        const map: Record<string, unknown> = { components: kb.components, faults: kb.faults, safety: kb.safety };
        if (!(name in map)) {
          json(res, 404, { error: `unknown knowledge set '${name}'` });
          logAccess(404);
          return;
        }
        json(res, 200, map[name]);
        logAccess(200);
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/tool/")) {
        const name = pathname.slice("/api/tool/".length);
        if (!name || name.includes("/")) {
          json(res, 404, { error: "not found" });
          logAccess(404);
          return;
        }
        const ip = clientIp(req, trustProxy);
        if (!toolIpLimit.hit(ip) || !toolGlobalLimit.hit("__global__")) {
          json(res, 429, { error: "Too many tool requests. Slow down and try again." }, { "Retry-After": "5" });
          logAccess(429);
          return;
        }
        const body = await readBody(req);
        if ("aborted" in body) return;
        if ("overflow" in body) {
          json(res, 413, { error: "body too large (max 256KB)" });
          logAccess(413);
          return;
        }
        let args: unknown;
        try {
          args = JSON.parse(body.text || "{}");
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          logAccess(400);
          return;
        }
        if (!isPlainObject(args)) {
          json(res, 400, { error: "JSON body must be an object" });
          logAccess(400);
          return;
        }
        const ctx = { logger, timing, t: t0, name };
        const finish = (status: number, bodyOut: unknown) => {
          if (timing) logger.debug({ event: "tool.timing", tool: ctx.name, ms: Date.now() - ctx.t });
          json(res, status, bodyOut);
          logAccess(status);
        };
        if (name === "lookup_component") {
          const query = args.query;
          if (typeof query !== "string" || query.length === 0) return finish(400, { error: "'query' must be a non-empty string" });
          if (query.length > 200) return finish(400, { error: "'query' exceeds 200 characters" });
          return finish(200, lookupComponent(kb, query));
        }
        if (name === "calc_circuit") {
          if (typeof args.kind !== "string") return finish(400, { error: "'kind' must be a string" });
          for (const k of ["vsupply", "vf", "current_ma"] as const) {
            const v = args[k];
            if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
              return finish(400, { error: `'${k}' must be a positive number` });
            }
          }
          return finish(200, calcCircuit((args as { kind: string; vsupply?: number; vf?: number; current_ma?: number })));
        }
        if (name === "debug_step") {
          const symptom = args.symptom;
          if (typeof symptom !== "string") return finish(400, { error: "'symptom' must be a string" });
          if (symptom.length > 2000) return finish(400, { error: "'symptom' exceeds 2000 characters" });
          const out = debugStep(kb, symptom) as Record<string, unknown>;
          const warn = checkSafety(kb, symptom);
          if (warn) out.safety = warn;
          return finish(200, out);
        }
        return finish(404, { error: `unknown tool '${name}'` });
      }

      if (req.method === "GET" && (pathname === "/api/agent" || pathname === "/api/health")) {
        json(res, 200, { ok: true, mock: !apiKey, agentConfigured: Boolean(agentId) });
        logAccess(200);
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        if (pathname === "/") {
          if (req.method === "HEAD") {
            res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" });
            res.end();
            logAccess(200);
            return;
          }
          await serveIndex(res);
          logAccess(200);
          return;
        }
        if (await serveStatic(req, res, pubDir)) {
          logAccess(200);
          return;
        }
        if (!pathname.startsWith("/api")) {
          if (req.method === "HEAD") {
            res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" });
            res.end();
            logAccess(200);
            return;
          }
          await serveIndex(res);
          logAccess(200);          return;
        }
      }

      json(res, 404, { error: "not found" });
      logAccess(404);
    } catch (err) {
      logger.error({ event: "handler_error", path: urlPath, error: err instanceof Error ? err.message : String(err) });
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) {
        json(res, 500, { error: "internal server error" });
        logAccess(500);
      } else {
        res.destroy();
      }
    }
  });

  server.on("clientError", (err, socket) => {
    logger.debug({ event: "client_error", reason: err.message });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}

function main(): void {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const logger = new Logger(logLevelFromEnv(process.env.LOG_LEVEL));
  const server = createApp({ logger });
  server.on("error", (err) => {
    logger.error({ event: "server_error", error: err.message });
    process.exit(1);
  });
  server.listen(port, host, () => {
    const live = Boolean(process.env.ASSEMBLYAI_API_KEY);
    logger.info({ event: "listen", host, port, live });
    console.log(
      `CircuitMate bench server on http://localhost:${port} ${live ? "(live voice)" : "(MOCK — set ASSEMBLYAI_API_KEY for live voice)"}`
    );
  });
}

const isEntry =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) main();
