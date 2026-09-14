#!/usr/bin/env node
/**
 * MCP server for the UNDP Open Data API (https://api.open.undp.org).
 *
 * Exposes UNDP's transparency data — projects, outputs, donors, SDG and focus
 * area funding — as MCP tools over stdio. The API needs no authentication.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerDonorTools } from "./tools/donors.js";

const server = new McpServer(
  { name: "undp-open-data", version: "1.0.0" },
  {
    instructions:
      "Access UNDP's open transparency data: projects, outputs, funding, donors, SDG and focus-area " +
      "breakdowns.\n\n" +
      "Guidance:\n" +
      "- Countries are identified by iso3 code. Resolve a name with undp_list_operating_units first.\n" +
      "- Most endpoints are year-scoped; undp_search_projects requires a `year`.\n" +
      "- For totals across a whole year ('top recipient countries', 'how much did donor X give'), use " +
      "undp_aggregate_projects rather than paging undp_search_projects.\n" +
      "- Financial values are USD. `budget` is allocated; `expenditure` is spent.",
  },
);

registerReferenceTools(server);
registerProjectTools(server);
registerDonorTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol; diagnostics must go to stderr.
  console.error("UNDP Open Data MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting UNDP MCP server:", error);
  process.exit(1);
});
