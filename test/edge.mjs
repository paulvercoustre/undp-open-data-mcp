import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "edge", version: "1.0.0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const call = async (name, args) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args });
  return { ms: Date.now() - t0, isError: !!r.isError, text: r.content[0].text };
};

console.log("--- 37MB donor index (cold) ---");
let r = await call("undp_search_donors", { query: "germany", limit: 3 });
console.log(`cold: ${r.ms}ms, ${r.text.length} chars, error=${r.isError}`);
const d = JSON.parse(r.text);
console.log("index_size:", d.index_size, "matches:", d.total);
console.log("sample:", JSON.stringify(d.items?.slice(0, 3)));

r = await call("undp_search_donors", { query: "gates", limit: 3 });
console.log(`warm (cached): ${r.ms}ms ->`, JSON.stringify(JSON.parse(r.text).items?.slice(0,2)));

console.log("\n--- error handling ---");
for (const [n, a] of [
  ["undp_get_project", { project_id: "00000000" }],
  ["undp_get_operating_unit", { iso3: "ZZZ" }],
  ["undp_get_output", { output_id: "bogus" }],
  ["undp_search_projects", { year: "1066" }],
  ["undp_aggregate_projects", { year: "1900" }],
]) {
  const res = await call(n, a);
  console.log(`${n}(${JSON.stringify(a)}) -> isError=${res.isError} ${res.text.replace(/\s+/g," ").slice(0,110)}`);
}

console.log("\n--- pagination continuity ---");
const p1 = JSON.parse((await call("undp_search_projects", { year: "2023", limit: 5, offset: 0 })).text);
const p2 = JSON.parse((await call("undp_search_projects", { year: "2023", limit: 5, offset: p1.next_offset })).text);
console.log("page1 ids:", p1.items.map(i => i.project_id).join(","), "next_offset:", p1.next_offset);
console.log("page2 ids:", p2.items.map(i => i.project_id).join(","));
const overlap = p1.items.filter(i => p2.items.some(j => j.project_id === i.project_id));
console.log("overlap:", overlap.length, overlap.length === 0 ? "(OK — pages are disjoint)" : "(BUG)");
console.log("total:", p1.total_matching_filters);

console.log("\n--- unit pagination ---");
const u1 = JSON.parse((await call("undp_get_operating_unit", { iso3: "ken", limit: 2, offset: 0 })).text);
const u2 = JSON.parse((await call("undp_get_operating_unit", { iso3: "KEN", limit: 2, offset: 2 })).text);
console.log("lowercase iso3 accepted:", u1.operating_unit, "| p1:", u1.items.map(i=>i.project_id).join(","), "| p2:", u2.items.map(i=>i.project_id).join(","));
console.log("total:", u1.total, "has_more:", u1.has_more);

await c.close(); process.exit(0);
