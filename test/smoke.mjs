// End-to-end smoke test: drives the server as a real MCP client over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}):`);
for (const t of tools) console.log(`  - ${t.name}`);

let pass = 0, fail = 0;
async function call(name, args, check) {
  const started = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    const ms = Date.now() - started;
    if (res.isError) { console.log(`\n✗ ${name} -> tool error: ${text.slice(0, 200)}`); fail++; return null; }
    const data = JSON.parse(text);
    const problem = check ? check(data) : null;
    if (problem) { console.log(`\n✗ ${name} (${ms}ms): ${problem}`); fail++; }
    else { console.log(`\n✓ ${name} (${ms}ms, ${text.length} chars)`); pass++; }
    return data;
  } catch (e) {
    console.log(`\n✗ ${name} threw: ${e.message}`); fail++; return null;
  }
}

const units = await call("undp_list_operating_units", { query: "kenya" },
  d => d.items?.[0]?.iso3 === "KEN" ? null : `expected KEN, got ${JSON.stringify(d.items?.[0])}`);
console.log("   ", JSON.stringify(units?.items?.[0]));

await call("undp_list_regions", {}, d => d.total === 7 ? null : `expected 7 regions, got ${d.total}`);

const sdgs = await call("undp_list_sdgs", { year: "2023" },
  d => d.items?.length === 17 ? null : `expected 17 SDGs, got ${d.items?.length}`);
console.log("    e.g.", JSON.stringify(sdgs?.items?.[0]));

const projects = await call("undp_search_projects", { year: "2023", operating_unit: "KEN", limit: 3 },
  d => d.items?.length > 0 && d.items[0].project_id ? null : "no projects returned");
console.log("    e.g.", JSON.stringify(projects?.items?.[0])?.slice(0, 220));

const pid = projects?.items?.[0]?.project_id;
const proj = await call("undp_get_project", { project_id: pid },
  d => d.project_id === pid ? null : `id mismatch: ${d.project_id}`);
console.log("    outputs:", proj?.outputs?.length, "budget:", proj?.budget);

const oid = proj?.outputs?.[0]?.output_id;
if (oid) {
  const out = await call("undp_get_output", { output_id: oid },
    d => d.output_id === oid ? null : `id mismatch: ${d.output_id}`);
  console.log("    financials:", JSON.stringify(out?.financials_by_year?.slice(0, 2)));
}

const agg = await call("undp_aggregate_projects", { year: "2023", group_by: "operating_unit", limit: 5 },
  d => d.groups?.length === 5 ? null : `expected 5 groups, got ${d.groups?.length}`);
console.log("    matched:", agg?.projects_matched, "top:", JSON.stringify(agg?.groups?.slice(0, 3)));

const byDonor = await call("undp_aggregate_projects", { year: "2023", group_by: "donor_country", limit: 5 });
console.log("    top donors:", JSON.stringify(byDonor?.groups?.slice(0, 3)));

await call("undp_get_operating_unit", { iso3: "KEN", limit: 3 },
  d => d.items?.length === 3 ? null : `expected 3, got ${d.items?.length}`);

await call("undp_list_crs_sectors", { query: "human rights" },
  d => d.items?.[0]?.code === "15162" ? null : `got ${JSON.stringify(d.items?.[0])}`);

await call("undp_list_focus_areas", { year: "2023" }, d => d.items?.length ? null : "empty");
await call("undp_list_signature_solutions", {}, d => d.items ? null : "empty");
await call("undp_list_sdg_targets", { sdg: "1" }, d => d.total > 0 ? null : "empty");
await call("undp_list_approaches", {}, d => d.items?.length ? null : "empty");
await call("undp_list_donor_countries", { query: "germany" },
  d => d.items?.[0]?.iso3 === "DEU" ? null : `got ${JSON.stringify(d.items?.[0])}`);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
await client.close();
process.exit(fail ? 1 : 0);
