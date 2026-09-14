import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo, Server } from "node:http";
import { request } from "node:http";
import { createApp, type AppDeps } from "../src/server.js";
import { MintError } from "../src/voice-token.js";

process.env.LOG_LEVEL = "silent";

const testDeps: AppDeps = {
  apiKey: "test-key",
  agentId: "test-agent",
  tokenIpLimit: 6,
  tokenGlobalLimit: 24,
  toolIpLimit: 120,
  toolGlobalLimit: 600,
};

let mintCalls = 0;
function mintStub() {
  mintCalls += 1;
  return Promise.resolve({ token: `stub-token-${mintCalls}` });
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", res);
  });
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function stop(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

const shared = createApp({ ...testDeps, mintToken: mintStub });
let base = "";

before(async () => {
  base = await start(shared);
});

after(async () => {
  await stop(shared);
});

async function get(path: string) {
  return fetch(base + path);
}

function rawGet(path: string): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path, method: "GET" }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("config + health", () => {
  it("returns config with no secrets and no-store", async () => {
    const r = await get("/api/config");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    assert.match(r.headers.get("x-content-type-options") ?? "", /nosniff/);
    const body = (await r.json()) as Record<string, unknown>;
    assert.deepEqual(
      { agentId: body.agentId, mock: body.mock, wsUrl: body.wsUrl },
      { agentId: "test-agent", mock: false, wsUrl: "wss://agents.assemblyai.com/v1/ws" },
    );
    assert.equal("access_token" in body, false);
    assert.equal("apiKey" in body, false);
  });

  it("reports mock mode when no key is configured", async () => {
    const mockServer = createApp({ agentId: "", apiKey: "" });
    const url = await start(mockServer);
    try {
      const r = await fetch(`${url}/api/health`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.deepEqual(body, { ok: true, mock: true, agentConfigured: false });
    } finally {
      await stop(mockServer);
    }
  });
});

describe("knowledge endpoint", () => {
  it("serves a valid knowledge set", async () => {
    const r = await get("/api/knowledge/components");
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.ok(body.arduino_uno);
  });

  it("404s unknown sets and never falls back to HTML", async () => {
    const r = await get("/api/knowledge/nope");
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  });
});

describe("tool endpoint", () => {
  it("ranks known tools", async () => {
    const r = await fetch(base + "/api/tool/lookup_component", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "esp32" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.id, "esp32");
  });

  it("calculates an LED resistor", async () => {
    const r = await fetch(base + "/api/tool/calc_circuit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "led_resistor", vsupply: 5, vf: 2, current_ma: 10 }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.recommended_ohms, 330);
  });

  it("rejects non-positive numbers instead of computing garbage", async () => {
    for (const args of [
      { kind: "led_resistor", vsupply: 5, vf: 2, current_ma: 0 },
      { kind: "led_resistor", vsupply: 5, vf: 2, current_ma: -10 },
      { kind: "led_resistor", vsupply: -5, vf: 2, current_ma: 10 },
      { kind: "led_resistor", vsupply: 5, vf: Number.NaN, current_ma: 10 },
    ]) {
      const r = await fetch(base + "/api/tool/calc_circuit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      assert.equal(r.status, 400, JSON.stringify(args));
    }
  });

  it("rejects non-object bodies and malformed JSON", async () => {
    const r = await fetch(base + "/api/tool/lookup_component", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["esp32"]),
    });
    assert.equal(r.status, 400);
    const r2 = await fetch(base + "/api/tool/lookup_component", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(r2.status, 400);
  });

  it("caps oversized input strings", async () => {
    const r = await fetch(base + "/api/tool/debug_step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symptom: "x".repeat(2001) }),
    });
    assert.equal(r.status, 400);
  });

  it("returns 413 for oversized bodies", async () => {
    let json = " ";
    while (json.length < 300000) json += ";";
    const r = await fetch(base + "/api/tool/calc_circuit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
    });
    assert.equal(r.status, 413);
  });

  it("404s unknown tools", async () => {
    const r = await fetch(base + "/api/tool/does_not_exist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 404);
  });
});

describe("voice-token endpoint", () => {
  it("mints a token server-side and never leaks the key", async () => {
    const r = await get("/api/voice-token");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    const body = (await r.json()) as Record<string, unknown>;
    assert.match(String(body.token), /^stub-token-/);
    assert.equal("key" in body, false);
  });

  it("rejects client-supplied token parameters", async () => {
    const r = await get("/api/voice-token?expires_in_seconds=99999");
    assert.equal(r.status, 400);
  });

  it("returns 503 mock mode without a key instead of minting", async () => {
    const mockServer = createApp({ apiKey: "", mintToken: mintStub });
    const url = await start(mockServer);
    try {
      const r = await fetch(`${url}/api/voice-token`);
      assert.equal(r.status, 503);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.mock, true);
    } finally {
      await stop(mockServer);
    }
  });

  it("maps upstream failures to a safe 502 without internal detail", async () => {
    const failServer = createApp({
      apiKey: "test-key",
      mintToken: () => Promise.reject(new MintError("upstream rejected token request", "upstream", 500)),
    });
    const url = await start(failServer);
    try {
      const r = await fetch(`${url}/api/voice-token`);
      assert.equal(r.status, 502);
      const body = (await r.json()) as { error?: string };
      assert.ok(body.error);
      assert.equal(body.error.includes("upstream"), false);
      assert.equal(body.error.includes("500"), false);
    } finally {
      await stop(failServer);
    }
  });

  it("rate-limits repeated mints from the same client", async () => {
    const limited = createApp({
      apiKey: "test-key",
      mintToken: mintStub,
      tokenIpLimit: 1,
      tokenGlobalLimit: 100,
    });
    const url = await start(limited);
    const tokenUrl = `${url}/api/voice-token`;
    try {
      assert.equal((await fetch(tokenUrl)).status, 200);
      const r2 = await fetch(tokenUrl);
      assert.equal(r2.status, 429);
      assert.match(r2.headers.get("retry-after") ?? "", /^\d+$/);
    } finally {
      await stop(limited);
    }
  });
});

describe("static + path handling", () => {
  it("serves the SPA and assets from public/ only", async () => {
    const r = await get("/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await r.text(), /CircuitMate/);
    assert.equal((await get("/app.js")).status, 200);
  });

  it("never serves files outside public/ via traversal", async () => {
    const r1 = await rawGet("/%2e%2e%2f%2e%2e%2f.env");
    assert.equal(r1.status, 404);
    assert.equal(r1.body.includes("ASSEMBLYAI_API_KEY="), false);
    const r2 = await rawGet("/foo/%2e%2e%2f.%2e%2f.env");
    assert.equal(r2.status, 404);
    assert.equal(r2.body.includes("ASSEMBLYAI_API_KEY="), false);
    const r3 = await rawGet("/%2e%2e/%2e%2e/.env");
    assert.match(r3.body, /^<!DOCTYPE/);
    assert.equal(r3.body.includes("ASSEMBLYAI_API_KEY="), false);
    const r4 = await rawGet("/%2e%2e%2f.env");
    assert.equal(r4.status, 404);
    assert.equal(r4.body.includes("ASSEMBLYAI_API_KEY="), false);
  });

  it("survives malformed percent-encoding", async () => {
    const r = await get("/%zz");
    assert.equal(r.status, 400);
    const r2 = await get("/api/config");
    assert.equal(r2.status, 200);
  });

  it("returns JSON 404 for unknown /api routes", async () => {
    const r = await get("/api/nope");
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  });
});