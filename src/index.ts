#!/usr/bin/env node
/**
 * stdio entry point — how local MCP clients (Claude Desktop, Cursor, VS Code)
 * run this server. For the hosted HTTP variant see http-server.ts.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol; diagnostics must go to stderr.
  console.error("UNDP Open Data MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting UNDP MCP server:", error);
  process.exit(1);
});
