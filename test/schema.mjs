// Offline contract test: starts the server and inspects tools/list only.
// Registration does no network I/O, so this runs anywhere and stays green even
// when the UNDP API is slow or down — which makes it the check CI can rely on.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = 15;
const fail = [];
const check = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) fail.push(msg); };

const client = new Client({ name: "schema-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const { tools } = await client.listTools();

check(tools.length === EXPECTED_TOOLS, `exposes ${EXPECTED_TOOLS} tools (got ${tools.length})`);

// Zod .default() emitted a JSON-Schema `default` that some MCP clients validated as
// required-but-missing, breaking every call that omitted an optional parameter.
// Defaults belong in the handlers; this fails if one creeps back into a schema.
const withDefaults = tools.filter((t) =>
  Object.values(t.inputSchema?.properties ?? {}).some((p) => "default" in p),
);
check(withDefaults.length === 0, `no tool emits a JSON-Schema default (${withDefaults.map((t) => t.name).join(", ") || "none"})`);

for (const tool of tools) {
  const schema = tool.inputSchema ?? {};
  check(schema.type === "object", `${tool.name}: schema is an object`);
  check(Boolean(tool.description?.length), `${tool.name}: has a description`);
  for (const [field, spec] of Object.entries(schema.properties ?? {})) {
    if (!spec.type && !spec.enum && !spec.anyOf) fail.push(`${tool.name}.${field}: no type`);
  }
}

// Tools that cannot work without an argument must declare it required.
const mustRequire = {
  undp_search_projects: "year",
  undp_aggregate_projects: "year",
  undp_get_project: "project_id",
  undp_get_output: "output_id",
  undp_get_operating_unit: "iso3",
  undp_search_donors: "query",
};
for (const [name, field] of Object.entries(mustRequire)) {
  const tool = tools.find((t) => t.name === name);
  check(Boolean(tool) && (tool.inputSchema.required ?? []).includes(field), `${name}: requires '${field}'`);
}

await client.close();
console.log(fail.length ? `\n✗ ${fail.length} check(s) failed` : `\n✓ all schema checks passed`);
process.exit(fail.length ? 1 : 0);
