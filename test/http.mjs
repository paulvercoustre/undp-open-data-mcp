// Starts the HTTP server on an ephemeral port, drives it with a real MCP client
// over Streamable HTTP, and checks the operational endpoints. Self-contained so
// CI can run it without any external process.
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const fail = [];
const check = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) fail.push(msg); };

const child = spawn("node", ["dist/http-server.js"], {
  env: { ...process.env, PORT: String(PORT), RATE_LIMIT: "5", RATE_WINDOW_MS: "60000" },
  stdio: ["ignore", "pipe", "pipe"],
});

// Wait for the listener rather than guessing a delay.
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server did not start in 20s")), 20_000);
  child.stdout.on("data", (d) => {
    if (d.toString().includes("http://")) { clearTimeout(timer); resolve(); }
  });
  child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
});

try {
  const health = await (await fetch(`${BASE}/health`)).json();
  check(health.status === "ok", `health endpoint reports ok (${JSON.stringify(health)})`);

  const notFound = await fetch(`${BASE}/nope`);
  check(notFound.status === 404, `unknown path returns 404 (got ${notFound.status})`);

  const preflight = await fetch(`${BASE}/mcp`, { method: "OPTIONS" });
  check(preflight.status === 204, `CORS preflight returns 204 (got ${preflight.status})`);
  check(preflight.headers.get("access-control-allow-origin") === "*", "preflight sets CORS origin");

  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  const { tools } = await client.listTools();
  check(tools.length === 15, `exposes 15 tools over HTTP (got ${tools.length})`);

  const res = await client.callTool({ name: "undp_list_operating_units", arguments: { query: "chad" } });
  const data = JSON.parse(res.content[0].text);
  check(data.items?.[0]?.iso3 === "TCD", `live tool call over HTTP returns Chad (${data.items?.[0]?.iso3})`);
  await client.close();

  // RATE_LIMIT is 5 for this run, so a short burst must start being rejected.
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rl", version: "1" } },
  });
  const codes = [];
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body,
    });
    codes.push(r.status);
  }
  check(codes.includes(429), `rate limiter rejects a burst (${codes.filter((c) => c === 429).length}/12 were 429)`);
} finally {
  child.kill("SIGTERM");
}

console.log(fail.length ? `\n✗ ${fail.length} check(s) failed` : "\n✓ all HTTP checks passed");
process.exit(fail.length ? 1 : 0);
