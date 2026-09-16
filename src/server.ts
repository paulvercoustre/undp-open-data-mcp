/**
 * Builds the MCP server. Shared by both entry points so the stdio transport
 * (Claude Desktop, Cursor, local clients) and the HTTP transport (hosted remote
 * connector) expose exactly the same tools and guidance.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerDonorTools } from "./tools/donors.js";

export const SERVER_INFO = { name: "undp-open-data", version: "1.0.0" } as const;

export const INSTRUCTIONS =
  "Access UNDP's open transparency data: projects, outputs, funding, donors, SDG and focus-area " +
  "breakdowns.\n\n" +
  "Guidance:\n" +
  "- Countries are identified by iso3 code. Resolve a name with undp_list_operating_units first.\n" +
  "- Most endpoints are year-scoped; undp_search_projects requires a `year`.\n" +
  "- For totals across a whole year ('top recipient countries', 'how much did donor X give'), use " +
  "undp_aggregate_projects rather than paging undp_search_projects.\n" +
  "- Financial values are USD. `budget` is allocated; `expenditure` is spent.";

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerReferenceTools(server);
  registerProjectTools(server);
  registerDonorTools(server);
  return server;
}
