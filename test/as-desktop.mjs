// Launches the server using the EXACT command/args from claude_desktop_config.json,
// in a stripped environment, to reproduce how Claude Desktop will start it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const cfgPath = `${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`;
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const entry = cfg.mcpServers?.["undp-open-data"];
if (!entry) { console.error("NOT CONFIGURED"); process.exit(1); }

console.log("config entry:", JSON.stringify(entry));
console.log("launching in a bare env (no nvm, no shell profile)...\n");

const transport = new StdioClientTransport({
  command: entry.command,
  args: entry.args,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir() },
});
const client = new Client({ name: "desktop-simulation", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`✓ connected — ${tools.length} tools exposed\n`);

let pass = 0, fail = 0;
const run = async (label, name, args, check) => {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text.slice(0, 120));
    const d = JSON.parse(r.content[0].text);
    const bad = check(d);
    if (bad) { console.log(`✗ ${label}: ${bad}`); fail++; return null; }
    console.log(`✓ ${label}`);
    pass++; return d;
  } catch (e) { console.log(`✗ ${label} threw: ${e.message}`); fail++; return null; }
};

console.log("Realistic questions a user would ask:\n");

const ke = await run('"Find Kenya"', "undp_list_operating_units", { query: "kenya" },
  d => d.items?.[0]?.iso3 === "KEN" ? null : "KEN not found");
console.log(`   → ${ke?.items[0].name}: $${(ke?.items[0].budget/1e6).toFixed(1)}M budget, ${ke?.items[0].project_count} projects\n`);

const top = await run('"Top recipient countries in 2023"', "undp_aggregate_projects",
  { year: "2023", group_by: "operating_unit", limit: 3 },
  d => d.groups?.length === 3 ? null : "expected 3 groups");
top?.groups.forEach((g,i) => console.log(`   ${i+1}. ${g.key}: $${(g.budget/1e6).toFixed(1)}M across ${g.projects} projects`));
console.log();

const pr = await run('"UNDP projects in Kenya, 2023"', "undp_search_projects",
  { year: "2023", operating_unit: "KEN", limit: 3 },
  d => d.items?.length ? null : "no projects");
console.log(`   → ${pr?.total_matching_filters} projects; first: "${pr?.items[0].title}"\n`);

const de = await run('"How much has Germany given?"', "undp_list_donor_countries", { query: "germany" },
  d => d.items?.[0]?.iso3 === "DEU" ? null : "DEU not found");
console.log(`   → ${de?.items[0].name}: $${(de?.items[0].total_budget/1e9).toFixed(2)}B via ${de?.items[0].organisation_count} orgs\n`);

const sdg = await run('"UNDP spend on climate (SDG 13)"', "undp_list_sdgs", { sdg: "13", year: "2023" },
  d => d.items?.length ? null : "no sdg data");
console.log(`   → ${sdg?.items[0].sdg_name}: $${(sdg?.items[0].total_budget/1e6).toFixed(1)}M, ${sdg?.items[0].total_projects} projects\n`);

console.log(`===== ${pass} passed, ${fail} failed =====`);
await client.close();
process.exit(fail ? 1 : 0);
