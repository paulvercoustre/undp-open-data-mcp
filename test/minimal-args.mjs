// Regression guard: every tool must work when optional parameters are omitted.
// Zod's .default() emitted a JSON-Schema `default` that some MCP clients validated
// as required-but-missing, so defaults live in the handlers instead. This test
// fails if a .default() creeps back into an input schema.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const c = new Client({ name: "minimal-args", version: "1.0.0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const { tools } = await c.listTools();

const withDefaults = tools.filter(t =>
  Object.values(t.inputSchema?.properties ?? {}).some(p => "default" in p));
if (withDefaults.length) {
  console.log("✗ tools emitting a JSON-Schema default:", withDefaults.map(t => t.name).join(", "));
  process.exit(1);
}
console.log("✓ no tool emits a JSON-Schema default");

const minimal = {
  undp_list_sdg_targets: { sdg: "1" }, undp_search_projects: { year: "2026" },
  undp_get_project: { project_id: "00122701" }, undp_get_output: { output_id: "00051078" },
  undp_get_operating_unit: { iso3: "TCD" }, undp_aggregate_projects: { year: "2026" },
  undp_search_donors: { query: "germany" },
};
let bad = 0;
for (const t of tools) {
  try {
    const r = await c.callTool({ name: t.name, arguments: minimal[t.name] ?? {} });
    const d = JSON.parse(r.content[0].text);
    if (r.isError || d.error) { console.log(`✗ ${t.name}: ${d.error ?? "error"}`); bad++; }
  } catch (e) { console.log(`✗ ${t.name} rejected: ${e.message.split("\n")[0]}`); bad++; }
}
console.log(bad ? `✗ ${bad} tool(s) failed with minimal args` : `✓ all ${tools.length} tools work with optional args omitted`);
await c.close();
process.exit(bad ? 1 : 0);
