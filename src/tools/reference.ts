/**
 * Reference / taxonomy tools: the code lists that every other tool's filters
 * refer to (operating units, regions, SDGs, focus areas, donors' sectors).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJson } from "../http.js";
import { errorResult, jsonResult, matchesQuery, paginate, round, toNumber, truncate } from "../format.js";

type Row = Record<string, any>;

/**
 * The index endpoints embed `top_donors` / `top_recipients` arrays that dominate
 * the payload. Trim them to the fields that matter and cap the count.
 */
const topOrgs = (values: unknown, max = 5) =>
  (Array.isArray(values) ? values : []).slice(0, max).map((org: Row) => ({
    id: org.organisation_id ?? org.code ?? org.id,
    name: org.organisation_name ?? org.name ?? org.short_name,
    budget: round(toNumber(org.total_budget ?? org.budget)),
    expense: round(toNumber(org.total_expense ?? org.expense)),
  }));

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    "undp_list_operating_units",
    {
      title: "List UNDP operating units",
      description:
        "List UNDP operating units (country offices and regional/global units) with headline budget, " +
        "expenditure and project counts. Use this to resolve a country name to the iso3 code that every " +
        "other tool's `operating_unit` filter expects.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive match on unit name or iso3 code, e.g. 'kenya'."),
        fund_type: z.string().optional().describe("Filter by fund type, e.g. 'Core', 'Other'."),
        sort_by: z
          .enum(["name", "budget", "expenditure", "projects"])
          .default("name")
          .describe("Sort key. Financial sorts are descending."),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ query, fund_type, sort_by, limit, offset }) => {
      try {
        const units = await getJson<Row[]>("/api/units/operating-unit-index.json");

        let rows = units.filter((unit) => matchesQuery(unit, query, ["id", "name"]));
        if (fund_type) {
          rows = rows.filter((unit) => String(unit.fund_type ?? "").toLowerCase() === fund_type.toLowerCase());
        }

        const sorters: Record<string, (a: Row, b: Row) => number> = {
          name: (a, b) => String(a.name).localeCompare(String(b.name)),
          budget: (a, b) => toNumber(b.budget_sum) - toNumber(a.budget_sum),
          expenditure: (a, b) => toNumber(b.expenditure_sum) - toNumber(a.expenditure_sum),
          projects: (a, b) => toNumber(b.project_count) - toNumber(a.project_count),
        };
        rows.sort(sorters[sort_by]);

        const page = paginate(rows, limit, offset);
        return jsonResult({
          ...page,
          items: page.items.map((unit) => ({
            iso3: unit.id,
            name: unit.name,
            fund_type: unit.fund_type,
            budget: toNumber(unit.budget_sum),
            expenditure: toNumber(unit.expenditure_sum),
            project_count: unit.project_count,
            funding_sources_count: unit.funding_sources_count,
            website: unit.web,
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_regions",
    {
      title: "List UNDP regions",
      description:
        "List the UNDP regional bureaux (RBA, RBAP, RBEC, RBLAC, RBAS, and global units) with aggregate " +
        "budget, expenditure and project counts, optionally including the countries in each region.",
      inputSchema: {
        include_countries: z
          .boolean()
          .default(false)
          .describe("Include the member-country list for each region. Adds substantial output."),
      },
    },
    async ({ include_countries }) => {
      try {
        const regions = await getJson<Row[]>("/api/region-index.json");

        return jsonResult({
          total: regions.length,
          items: regions.map((region) => ({
            id: region.id,
            name: region.name,
            aggregate: region.aggregate,
            ...(include_countries
              ? {
                  countries: (region.countries ?? []).map((country: Row) => ({
                    iso3: country.code,
                    name: country.name,
                    unit_type: country.unit_type,
                    donor_lvl: country.donor_lvl,
                  })),
                }
              : { country_count: (region.countries ?? []).length }),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_sdgs",
    {
      title: "List SDGs with UNDP funding",
      description:
        "List the 17 Sustainable Development Goals with UNDP project counts, budget and expenditure. " +
        "Filterable by year, operating unit and budget source. Set `include_targets` for target-level detail " +
        "on a single SDG.",
      inputSchema: {
        year: z.string().optional().describe("Four-digit year. Defaults to the current year upstream."),
        sdg: z.string().optional().describe("SDG code 1-17, to return just that goal."),
        operating_unit: z.string().optional().describe("Operating unit iso3, e.g. 'KEN'."),
        budget_source: z.string().optional().describe("Budget source iso3 or donor code."),
        include_targets: z
          .boolean()
          .default(false)
          .describe("Include per-target breakdown. Best combined with `sdg` — it is verbose."),
      },
    },
    async ({ year, sdg, operating_unit, budget_source, include_targets }) => {
      try {
        const goals = await getJson<Row[]>("/api/sdg-index.json", { year, sdg, operating_unit, budget_source });

        return jsonResult({
          filters: { year: year ?? "current", sdg, operating_unit, budget_source },
          total: goals.length,
          items: goals.map((goal) => ({
            sdg_code: goal.sdg_code,
            sdg_name: goal.sdg_name,
            total_projects: goal.total_projects,
            total_donors: goal.total_donors,
            total_budget: round(toNumber(goal.total_budget)),
            total_expense: round(toNumber(goal.total_expense)),
            percentage_of_budget: goal.percentage,
            ...(include_targets
              ? {
                  targets: (goal.target_details ?? []).map((target: Row) => ({
                    target_id: target.target_id,
                    description: truncate(target.description, 300),
                    budget: round(toNumber(target.total_budget ?? target.budget)),
                    expense: round(toNumber(target.total_expense ?? target.expense)),
                    projects: target.total_projects ?? target.projects,
                  })),
                }
              : { target_count: (goal.target_details ?? []).length }),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_sdg_targets",
    {
      title: "List SDG targets",
      description:
        "List SDG target-level data (the 1.1, 1.2 … sub-goals) with associated UNDP funding. " +
        "Filter by SDG code, target id and year.",
      inputSchema: {
        sdg: z.string().optional().describe("SDG code 1-17."),
        target: z.string().optional().describe("Specific target id, e.g. '1.1'."),
        year: z.string().optional().describe("Four-digit year."),
        include_top_donors: z.boolean().default(false).describe("Include the top donors funding each target."),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ sdg, target, year, include_top_donors, limit, offset }) => {
      try {
        const payload = await getJson<unknown>("/api/target-index.json", { sdg, target, year });
        const rows: Row[] = Array.isArray(payload)
          ? payload
          : ((payload as Row)?.data ?? (payload as Row)?.targets ?? []);

        const page = paginate(rows, limit, offset);
        return jsonResult({
          filters: { sdg, target, year: year ?? "current" },
          ...page,
          items: page.items.map((row) => ({
            target_id: row.target_id,
            description: truncate(row.description, 300),
            budget: round(toNumber(row.target_budget)),
            expense: round(toNumber(row.target_expense)),
            total_projects: row.total_projects,
            total_donors: row.total_donors,
            ...(include_top_donors ? { top_donors: topOrgs(row.top_donors) } : {}),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_focus_areas",
    {
      title: "List UNDP focus areas",
      description:
        "List UNDP's focus areas ('Our Focus' thematic pillars) with budget, expenditure, project and " +
        "donor counts. Optionally include each area's top donors.",
      inputSchema: {
        year: z.string().optional().describe("Four-digit year."),
        operating_unit: z.string().optional().describe("Operating unit iso3."),
        budget_source: z.string().optional().describe("Budget source iso3 or donor code."),
        include_top_donors: z.boolean().default(false).describe("Include the top donors per focus area."),
      },
    },
    async ({ year, operating_unit, budget_source, include_top_donors }) => {
      try {
        const areas = await getJson<Row[]>("/api/focus-area-index.json", { year, operating_unit, budget_source });

        return jsonResult({
          filters: { year: year ?? "current", operating_unit, budget_source },
          total: areas.length,
          items: areas.map((area) => ({
            sector_code: area.sector,
            name: area.sector_name,
            year: area.year,
            total_projects: area.total_projects,
            total_outputs: area.total_outputs,
            total_donors: area.total_donors,
            countries: area.countries,
            budget: round(toNumber(area.budget)),
            expense: round(toNumber(area.expense)),
            percentage: area.percentage,
            ...(include_top_donors ? { top_donors: area.top_donors ?? [] } : {}),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_signature_solutions",
    {
      title: "List UNDP signature solutions",
      description:
        "List UNDP's six signature solutions (the Strategic Plan delivery areas) with aggregate funding " +
        "and project counts.",
      inputSchema: {
        include_details: z
          .boolean()
          .default(false)
          .describe("Include top budget sources and top recipient offices for each solution."),
      },
    },
    async ({ include_details }) => {
      try {
        const payload = await getJson<Row>("/api/signature-solutions-index.json");
        const solutions: Row[] = payload.signature_solutions ?? [];

        return jsonResult({
          aggregate: payload.aggregate,
          total: solutions.length,
          items: solutions.map((solution) => ({
            ss_id: solution.ss_id,
            name: solution.signature_solution,
            year: solution.year,
            budget: round(toNumber(solution.budget)),
            expense: round(toNumber(solution.expense)),
            projects: solution.projects,
            total_outputs: solution.total_outputs,
            operating_units: solution.operating_units,
            donors: solution.donors,
            percentage: solution.percentage,
            ...(include_details
              ? {
                  top_budget_sources: topOrgs(solution.budget_sources),
                  top_recipient_offices: topOrgs(solution.top_recipient_offices),
                }
              : {}),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_approaches",
    {
      title: "List UNDP approaches and markers",
      description:
        "List 'Our Approaches' — the policy markers UNDP tags projects with (gender, capacity development, " +
        "and similar). The marker types and ids returned here feed the `marker_type` / `marker_id` filters " +
        "on undp_search_projects.",
      inputSchema: {
        year: z.string().optional().describe("Four-digit year."),
        operating_unit: z.string().optional().describe("Operating unit iso3."),
        include_top_donors: z.boolean().default(false).describe("Include top donors and recipients per marker."),
      },
    },
    async ({ year, operating_unit, include_top_donors }) => {
      try {
        const markers = await getJson<Row[]>("/api/our-approaches-index.json", { year, operating_unit });

        return jsonResult({
          filters: { year: year ?? "current", operating_unit },
          total: markers.length,
          items: markers.map((marker) => ({
            marker_type: marker.marker_type,
            marker: marker.marker,
            budget: round(toNumber(marker.budget)),
            expense: round(toNumber(marker.expense)),
            project_count: marker.project_count,
            donor_count: marker.donor_count,
            // These marker_id values feed the `marker_id` filter on undp_search_projects.
            sub_types: (marker.sub_type ?? []).map((sub: Row) => ({
              marker_id: sub.marker_id,
              title: sub.title,
            })),
            ...(include_top_donors
              ? { top_donors: topOrgs(marker.top_donors), top_recipients: topOrgs(marker.top_recipients) }
              : {}),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_crs_sectors",
    {
      title: "List OECD DAC CRS sector codes",
      description:
        "List the OECD DAC CRS sector codes used to classify UNDP outputs (e.g. 15162 'Human rights'). " +
        "Useful for decoding the `crs` field on an output.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive match on sector name or code."),
      },
    },
    async ({ query }) => {
      try {
        // Upstream inverts these fields: `id` carries the label and `name` the numeric code.
        const sectors = await getJson<Row[]>("/api/crs-index.json");

        const rows = sectors
          .map((sector) => ({ code: sector.name, name: sector.id }))
          .filter((sector) => matchesQuery(sector, query, ["code", "name"]));

        return jsonResult({ total: rows.length, items: rows });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
