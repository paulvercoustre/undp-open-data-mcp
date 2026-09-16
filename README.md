# UNDP Open Data MCP Server

An MCP server for the [UNDP Open Data API](https://api.open.undp.org/api_documentation/api#/api) —
UNDP's transparency data on projects, outputs, funding, donors, SDG alignment and focus areas.

No API key or authentication required.

## Install

`dist/` is gitignored, so build after cloning:

```bash
npm install && npm run build
```

## Running it

You do not start this server yourself — the MCP client launches it on demand and
talks to it over stdio. To check it works standalone:

```bash
npm run build && node dist/index.js
```

It should print `UNDP Open Data MCP server running on stdio` to stderr and then wait
for JSON-RPC on stdin. Ctrl-C to stop. Nothing further will happen without a client
attached; that is expected.

To exercise every tool against the live API:

```bash
node test/smoke.mjs
```

## Connecting to Claude

### Claude Code (CLI)

From an interactive terminal:

```bash
claude mcp add undp-open-data --scope user -- node /Users/paulvercoustre/Documents/data_science/LLMs/undp_db_mcp/dist/index.js
```

`--scope user` makes it available in every project. Use `--scope project` instead to
write a `.mcp.json` into the current project and share it with collaborators. Verify
with `claude mcp list`, or `/mcp` inside a session.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "undp-open-data": {
      "command": "node",
      "args": ["/Users/paulvercoustre/Documents/data_science/LLMs/undp_db_mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop, then check the tools appear in the MCP/tools menu.

Both need the absolute path, and `node` must be on the launching process's `PATH`.
If the client reports the server failing to start, run the `node dist/index.js`
command above by hand — the error will be clearer there.

### Asking for things once connected

- "Which countries received the most UNDP funding in 2023?" → `undp_aggregate_projects`
- "What is UNDP doing in Kenya on climate?" → `undp_list_operating_units`, then `undp_search_projects`
- "How much has Germany contributed?" → `undp_list_donor_countries` / `undp_search_donors`

## Tools

### Reference data
| Tool | Purpose |
| --- | --- |
| `undp_list_operating_units` | Country offices and regional units. **Start here** to resolve a country name to its iso3 code. |
| `undp_list_regions` | The regional bureaux (RBA, RBAP, RBEC, RBLAC, RBAS) with aggregates. |
| `undp_list_sdgs` | The 17 SDGs with UNDP funding, filterable by year/unit/donor. |
| `undp_list_sdg_targets` | Target-level (1.1, 1.2 …) funding detail. |
| `undp_list_focus_areas` | 'Our Focus' thematic pillars. |
| `undp_list_signature_solutions` | The six signature solutions. |
| `undp_list_approaches` | Policy markers — supplies the `marker_type`/`marker_id` filter values. |
| `undp_list_crs_sectors` | OECD DAC CRS sector codes. |

### Projects
| Tool | Purpose |
| --- | --- |
| `undp_search_projects` | Search projects for a year, filtered by country, SDG, sector, donor, marker. Paginated. |
| `undp_get_project` | One project in full: dates, fiscal-year financials, outputs, locations, documents. |
| `undp_get_output` | One output: CRS sector, gender marker, per-donor and per-year financials. |
| `undp_get_operating_unit` | A country office's whole portfolio, paginated. |
| `undp_aggregate_projects` | **Totals across a full year** grouped by country, region, donor country, donor type, CRS sector, or core vs non-core. |

### Donors
| Tool | Purpose |
| --- | --- |
| `undp_search_donors` | Search 6,200+ funding organisations by name. Query required. |
| `undp_list_donor_countries` | Donor countries ranked by contribution, with contributing organisations. |

## Design notes

The upstream API is generous with payload size — several endpoints return far more than
fits in a model's context window:

| Endpoint | Raw size |
| --- | --- |
| `donor-index.json` | ~37 MB (6,221 donors) |
| `project_summary_<year>.json` | ~7 MB (4,619 projects for 2023) |
| `units/<iso3>.json` | ~600 KB for a single country |

So no tool returns a raw upstream document. Instead:

- **Everything is paginated.** Lists return `total`, `has_more` and `next_offset`; pass
  `next_offset` back as `offset` to continue.
- **Verbose nested data is opt-in.** Outputs, documents, locations, and `top_donors` arrays sit
  behind `include_*` flags, because they dominate the payload when left in.
- **Text search covers the whole result set.** `query` on `undp_search_projects` pulls every
  project matching the structured filters (pages fetched concurrently, ~2.5 s cold for a full
  year, then cached) and matches title and description across all of them, so counts are real
  rather than whatever landed on the first page.
- **Aggregation happens server-side.** `undp_aggregate_projects` reduces a whole year of
  projects to ranked totals, so "which countries received the most funding in 2023" costs one
  call instead of paging through 4,619 records.
- **Large documents are cached** in memory (1 h TTL by default), with concurrent requests for the
  same URL deduplicated. The donor index takes ~7 s cold and ~3 ms warm.
- **A hard size guard** (100 k chars) backstops every result, returning a recoverable error with
  guidance rather than flooding the context.

Upstream quirks handled:

- `crs-index.json` inverts its fields — `id` holds the label and `name` the numeric code. The
  server normalises this to `{code, name}`.
- `project_list` supports undocumented `limit`/`offset` parameters (visible only in its `next`
  link); the server uses them for real server-side pagination.
- Output `budget`, `expenditure` and `fiscal_year` arrive as parallel arrays; `undp_get_output`
  zips them into per-year records.
- `sdg-index` and `focus-area-index` accept an `operating_unit` parameter (it is in the published
  spec) but return an empty array for *every* country, including ones with active projects. The
  server detects this and returns an explicit warning naming the working alternative, rather than
  an empty list that reads as "no such work in that country".
- In `group_by: "donor_country"`, per-donor amounts are used rather than the project total, so
  multi-donor projects aren't counted several times over. Note that upstream includes
  non-country funders (e.g. `GFATM`, `UNDP`) in the donor-country field.

The API's `download/undp-project-data.zip` endpoint is deliberately not exposed — it is a bulk
binary download, not something to hand back through a tool call.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `UNDP_API_BASE` | `https://api.open.undp.org` | API base URL. |
| `UNDP_CACHE_TTL_MS` | `3600000` | Cache lifetime. `0` disables caching. |
| `UNDP_TIMEOUT_MS` | `60000` | Per-request timeout (the big endpoints are slow). |
| `UNDP_MAX_RESULT_CHARS` | `100000` | Tool result size ceiling. |

## Tests

```bash
node test/smoke.mjs
node test/minimal-args.mjs
```

`smoke.mjs` drives the server as a real MCP client over stdio and exercises all 15 tools.
`minimal-args.mjs` calls every tool with optional parameters omitted, and fails if any input
schema emits a JSON-Schema `default` — Zod's `.default()` produced schemas that some MCP
clients rejected as required-but-missing, so defaults are applied in the handlers instead.
`test/edge.mjs` covers the 37 MB donor path, error handling and pagination continuity.

## Data source

Data from the [UNDP Open Data API](https://api.open.undp.org). Financial values are USD;
`budget` is allocated funding and `expenditure` is spent.
