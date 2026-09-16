#!/usr/bin/env node
/**
 * HTTP entry point — serves the same tools over Streamable HTTP so the server can
 * be hosted and added to claude.ai as a remote custom connector. Local clients
 * should use the stdio entry point (index.ts) instead.
 *
 * Stateless by design: every request gets a fresh server and transport, so there
 * is no session state to pin a client to one process and it scales horizontally.
 *
 * Note this exposes a public endpoint that makes requests to the UNDP API on a
 * caller's behalf, so it rate-limits per IP. The UNDP data itself is public and
 * needs no credentials, which is why no auth layer is built in here.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_INFO } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

/** Requests allowed per IP per window. Generous for humans, a brake on abuse. */
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60_000);
/** Reject oversized bodies rather than buffering them. */
const MAX_BODY_BYTES = 1_000_000;

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// Bound the map so a spray of unique IPs cannot grow it without limit.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function clientIp(req: IncomingMessage): string {
  // Behind a reverse proxy the socket address is the proxy, so prefer the
  // forwarded header when one is present.
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Browsers preflight the MCP endpoint before POSTing to it.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // Unauthenticated liveness probe for load balancers and uptime checks.
  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", server: SERVER_INFO.name, version: SERVER_INFO.version });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "not found", hint: "MCP endpoint is POST /mcp; liveness is GET /health" });
    return;
  }

  if (rateLimited(clientIp(req))) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_WINDOW_MS / 1000)));
    sendJson(res, 429, { error: "rate limit exceeded", limit: RATE_LIMIT, window_ms: RATE_WINDOW_MS });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;

    // Fresh server + transport per request: no cross-request state to leak, and
    // nothing tying a client to a particular process behind a load balancer.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Request failed:", message);
    if (!res.headersSent) sendJson(res, 400, { error: message });
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`UNDP Open Data MCP server (HTTP) on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint: POST /mcp`);
  console.log(`  Health:       GET  /health`);
  console.log(`  Rate limit:   ${RATE_LIMIT} requests per ${RATE_WINDOW_MS / 1000}s per IP`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
  });
}
