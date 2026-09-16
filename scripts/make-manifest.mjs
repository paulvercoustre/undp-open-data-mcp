// Writes the .mcpb manifest. Kept as its own file rather than an inline `node -e`
// string, so prose containing apostrophes cannot break shell quoting.
import { writeFileSync, readFileSync } from "node:fs";

const [, , outDir] = process.argv;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const manifest = {
  manifest_version: "0.3",
  name: "undp-open-data",
  display_name: "UNDP Open Data",
  version,
  description: "Query UNDP project, funding and donor data from api.open.undp.org.",
  long_description: [
    "Ask questions about UNDP projects, budgets, donors, SDG alignment and focus areas, drawing on the public UNDP transparency API.",
    "",
    "Covers 2012 to the present. Financial values are USD: `budget` is allocated funding and `expenditure` is what has been spent. The current year is partial and still being booked, so its totals are not final.",
    "",
    "This is a record of funding already committed. It does not list open calls, tenders or upcoming funding opportunities.",
  ].join("\n"),
  author: { name: "Paul Vercoustre" },
  license: "MIT",
  keywords: ["undp", "development", "funding", "donors", "sdg", "open data"],
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=18.0.0" },
  },
};

writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`    manifest.json v${version}`);
