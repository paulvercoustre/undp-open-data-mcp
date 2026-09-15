/**
 * Project, output and operating-unit tools.
 *
 * These wrap the heaviest endpoints in the API, so each one summarises or
 * paginates before returning: a single country's unit document is ~600 KB and a
 * year of project summaries is ~7 MB.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJson } from "../http.js";
import { errorResult, jsonResult, matchesQuery, paginate, round, toNumber, truncate } from "../format.js";

type Row = Record<string, any>;

/** The API caps `limit` at 1000 per request, whatever larger value is asked for. */
const MAX_PAGE_SIZE = 1000;
/** Safety valve so a pathological filter can never fetch unbounded pages. */
const MAX_PAGES = 12;

/**
 * Fetch every project matching the server-side filters, following pagination.
 *
 * Needed because `query` is a text search the upstream API does not support: to
 * search honestly we must hold the whole filtered set, not just one page. At 1000
 * rows per request a full year is ~5 calls, and each page is cached individually.
 */
async function fetchAllProjects(
  filters: Record<string, unknown>,
): Promise<{ rows: Row[]; total: number; truncated: boolean }> {
  const readPage = async (offset: number) => {
    const payload = await getJson<Row>("/api/project_list/", {
      ...filters,
      limit: MAX_PAGE_SIZE,
      offset,
    });
    const body = payload?.data ?? {};
    return { rows: (body?.data ?? []) as Row[], total: (body?.count ?? 0) as number };
  };

  // The first page reveals the total, which tells us how many more to fetch.
  const first = await readPage(0);
  const total = first.total;

  if (first.rows.length === 0 || first.rows.length >= total) {
    return { rows: first.rows, total, truncated: false };
  }

  const pagesNeeded = Math.ceil(total / MAX_PAGE_SIZE);
  const pagesToFetch = Math.min(pagesNeeded, MAX_PAGES);
  const truncated = pagesNeeded > MAX_PAGES;

  // Fetch the remainder concurrently: sequential paging made a full year take ~40s,
  // while each page costs only ~1s on its own.
  const rest = await Promise.all(
    Array.from({ length: pagesToFetch - 1 }, (_, i) => readPage((i + 1) * MAX_PAGE_SIZE)),
  );

  return { rows: [...first.rows, ...rest.flatMap((page) => page.rows)], total, truncated };
}

/** Flatten the `[{code,name}]` taxonomy arrays the project list embeds. */
const names = (values: unknown): string[] =>
  Array.isArray(values)
    ? values.map((value) => (typeof value === "string" ? value : (value?.name ?? value?.id ?? ""))).filter(Boolean)
    : [];

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "undp_search_projects",
    {
      title: "Search UNDP projects",
      description:
        "Search UNDP projects for a given year, filtered by country, SDG, focus area, signature solution, " +
        "budget source or policy marker. Returns a compact record per project (title, budget, expenditure, " +
        "SDGs, donors). Results are paginated — follow `next_offset` for more. " +
        "Use undp_get_project for the full detail of one project.",
      inputSchema: {
        year: z.string().describe("Four-digit year. Required by the API, e.g. '2023'."),
        operating_unit: z.string().optional().describe("Operating unit iso3, e.g. 'KEN'."),
        budget_source: z.string().optional().describe("Budget source iso3 or donor code."),
        budget_type: z.string().optional().describe("Budget type, e.g. 'core' / 'non-core'."),
        sdg: z.string().optional().describe("SDG code 1-17."),
        sdg_target: z.string().optional().describe("SDG target code, e.g. '1.1'."),
        sector: z.string().optional().describe("Focus area ('our focus') code."),
        signature_solution: z.string().optional().describe("Signature solution code."),
        marker_type: z.string().optional().describe("Policy marker type, from undp_list_approaches."),
        marker_id: z.string().optional().describe("Policy marker subtype id."),
        query: z
          .string()
          .optional()
          .describe(
            "Free-text search over the title and description of EVERY project matching the other " +
              "filters, not just one page. Costs a few extra requests on a cold cache. Combine with " +
              "`year`/`operating_unit` to keep it quick.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(25)
          .describe("Projects per page (max 50). Each carries SDG, donor and marker lists, so a larger page cannot fit one result."),
        offset: z.number().int().min(0).default(0),
        include_description: z.boolean().default(true).describe("Include the (truncated) project description."),
      },
    },
    async (args) => {
      try {
        const { query, limit, offset, include_description, ...filters } = args;

        // Descriptions dominate the payload, so give each one a smaller share as the
        // page grows. Keeps a full page comfortably under the result-size ceiling.
        const descriptionChars = limit <= 25 ? 400 : 250;

        const compact = (row: Row) => ({
          project_id: row.project_id,
          title: row.title,
          ...(include_description ? { description: truncate(row.description, descriptionChars) } : {}),
          country: row.country,
          budget: toNumber(row.budget),
          expense: toNumber(row.expense),
          sdgs: names(row.sdg),
          focus_areas: names(row.sector),
          signature_solutions: names(row.signature_solution),
          donors: names(row.donor),
          markers: names(row.marker),
        });

        // Text search: pull the whole filtered set, then match and paginate locally,
        // so counts reflect every project rather than an arbitrary first page.
        if (query) {
          const { rows: all, total, truncated } = await fetchAllProjects(filters);
          const matched = all.filter((row) => matchesQuery(row, query, ["title", "description"]));
          const page = paginate(matched, limit, offset);

          return jsonResult({
            filters: { ...filters, query },
            searched: all.length,
            total_matching_filters: total,
            total_matching_query: matched.length,
            total: page.total,
            returned: page.returned,
            limit: page.limit,
            offset: page.offset,
            has_more: page.has_more,
            next_offset: page.next_offset,
            ...(truncated
              ? {
                  warning:
                    `Only the first ${all.length} of ${total} projects were searched (page cap reached). ` +
                    "Add filters such as `operating_unit` to search the whole set.",
                }
              : {}),
            items: page.items.map(compact),
          });
        }

        const payload = await getJson<Row>("/api/project_list/", { ...filters, limit, offset });
        const body = payload?.data ?? {};
        const rows: Row[] = body?.data ?? [];
        const total: number = body?.count ?? rows.length;

        return jsonResult({
          filters,
          total_matching_filters: total,
          returned: rows.length,
          limit,
          offset,
          has_more: offset + rows.length < total,
          next_offset: offset + rows.length < total ? offset + rows.length : null,
          items: rows.map(compact),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_get_project",
    {
      title: "Get a UNDP project",
      description:
        "Get the full record for one UNDP project: dates, budget and expenditure by fiscal year, outputs, " +
        "subnational locations and linked documents. Project ids look like '00122701' and come from " +
        "undp_search_projects.",
      inputSchema: {
        project_id: z.string().describe("Project id, e.g. '00122701'."),
        include_outputs: z.boolean().default(true).describe("Include the project's outputs."),
        include_documents: z.boolean().default(false).describe("Include linked document titles and URLs."),
        include_locations: z.boolean().default(false).describe("Include subnational locations with coordinates."),
      },
    },
    async ({ project_id, include_outputs, include_documents, include_locations }) => {
      try {
        const project = await getJson<Row>(`/api/projects/${encodeURIComponent(project_id)}.json`);

        return jsonResult({
          project_id: project.project_id,
          title: project.project_title,
          description: truncate(project.project_descr, 2_000),
          operating_unit: { iso3: project.operating_unit_id, name: project.operating_unit },
          region_id: project.region_id,
          start: project.start,
          end: project.end,
          budget: toNumber(project.budget),
          expenditure: toNumber(project.expenditure),
          fiscal_years: project.fiscal_year,
          implementing_partner: { id: project.inst_id, name: project.inst_descr, type: project.inst_type_id },
          contact: { email: project.operating_unit_email, website: project.operating_unit_website },
          ...(include_outputs
            ? {
                outputs: (project.outputs ?? []).map((output: Row) => ({
                  output_id: output.output_id,
                  title: output.title ?? output.output_title,
                  description: truncate(output.description ?? output.output_descr, 300),
                  budget: toNumber(output.budget),
                  expenditure: toNumber(output.expenditure),
                })),
              }
            : { output_count: (project.outputs ?? []).length }),
          ...(include_locations
            ? { subnational: project.subnational ?? [] }
            : { subnational_count: (project.subnational ?? []).length }),
          ...(include_documents
            ? {
                documents: (project.documents ?? []).slice(0, 50).map((doc: Row, index: number) => ({
                  name: Array.isArray(project.document_name) ? project.document_name[index] : undefined,
                  url: typeof doc === "string" ? doc : (doc?.url ?? doc),
                })),
              }
            : { document_count: (project.documents ?? []).length }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_get_output",
    {
      title: "Get a UNDP project output",
      description:
        "Get one project output: its CRS sector, gender marker, SDG tags, and budget / expenditure / " +
        "disbursement broken down by fiscal year and donor. Output ids come from undp_get_project.",
      inputSchema: {
        output_id: z.string().describe("Output id, e.g. '00051078'."),
      },
    },
    async ({ output_id }) => {
      try {
        const output = await getJson<Row>(`/api/outputs/${encodeURIComponent(output_id)}.json`);

        // Budget, expenditure and fiscal_year are parallel arrays upstream; zip them.
        const years: unknown[] = output.fiscal_year ?? [];
        const financials = years.map((year, index) => ({
          fiscal_year: year,
          budget: toNumber(output.budget?.[index]),
          expenditure: toNumber(output.expenditure?.[index]),
          disbursement: toNumber(output.disbursement?.[index]),
        }));

        return jsonResult({
          output_id: output.output_id,
          project_id: output.award_id,
          title: output.output_title,
          description: truncate(output.output_descr, 1_500),
          crs: { code: output.crs, name: output.crs_descr },
          focus_area: { code: output.focus_area, name: output.focus_area_descr },
          gender: { id: output.gender_id, description: output.gender_descr },
          sdgs: output.sdg ?? [],
          markers: output.markers ?? [],
          donors: (output.donor_id ?? []).map((id: string, index: number) => ({
            donor_id: id,
            name: output.donor_name?.[index],
            short_name: output.donor_short?.[index],
          })),
          financials_by_year: financials,
          totals: {
            budget: round(financials.reduce((sum, row) => sum + row.budget, 0)),
            expenditure: round(financials.reduce((sum, row) => sum + row.expenditure, 0)),
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_get_operating_unit",
    {
      title: "Get an operating unit's portfolio",
      description:
        "Get one operating unit's (country office's) full project portfolio, including each project's " +
        "outputs and subnational locations. The upstream document is large, so projects are paginated and " +
        "outputs are summarised by default.",
      inputSchema: {
        iso3: z.string().describe("Operating unit iso3 code, e.g. 'KEN'."),
        include_outputs: z.boolean().default(false).describe("Include each project's outputs. Verbose."),
        include_locations: z.boolean().default(false).describe("Include subnational locations."),
        query: z.string().optional().describe("Filter projects by title."),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ iso3, include_outputs, include_locations, query, limit, offset }) => {
      try {
        const unit = await getJson<Row>(`/api/units/${encodeURIComponent(iso3.toUpperCase())}.json`);
        const all: Row[] = unit.projects ?? [];
        const filtered = query ? all.filter((project) => matchesQuery(project, query, ["title"])) : all;
        const page = paginate(filtered, limit, offset);

        return jsonResult({
          operating_unit: unit.op_unit,
          iso_num: unit.iso_num,
          project_count: all.length,
          ...page,
          items: page.items.map((project) => ({
            project_id: project.id,
            title: project.title,
            output_count: (project.outputs ?? []).length,
            location_count: (project.subnational ?? []).length,
            ...(include_outputs
              ? {
                  outputs: (project.outputs ?? []).map((output: Row) => ({
                    output_id: output.output_id,
                    title: output.title,
                    description: truncate(output.description, 200),
                    sector: output.sector,
                    sdgs: output.sdg ?? [],
                    signature_solutions: output.signature_solution ?? [],
                  })),
                }
              : {}),
            ...(include_locations
              ? {
                  locations: (project.subnational ?? []).map((location: Row) => ({
                    name: location.name,
                    lat: location.lat,
                    lon: location.lon,
                    type: location.type,
                    focus_area: location.focus_area_descr,
                  })),
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
    "undp_aggregate_projects",
    {
      title: "Aggregate UNDP project funding",
      description:
        "Aggregate a full year of UNDP projects by operating unit, region, donor country, donor type or CRS " +
        "sector, returning totalled budget, expenditure and project counts. This is the tool for questions " +
        "like 'which countries got the most funding in 2023' or 'how much did Germany fund' — it summarises " +
        "the whole year server-side instead of paging through thousands of projects.",
      inputSchema: {
        year: z.string().describe("Four-digit year, e.g. '2023'."),
        group_by: z
          .enum(["operating_unit", "region", "donor_country", "donor_type", "crs", "core_vs_noncore"])
          .default("operating_unit")
          .describe("Dimension to group by."),
        operating_unit: z.string().optional().describe("Restrict to one operating unit iso3."),
        region: z.string().optional().describe("Restrict to one region id, e.g. 'RBA'."),
        donor_country: z.string().optional().describe("Restrict to projects funded by this donor country iso3."),
        sort_by: z.enum(["budget", "expenditure", "projects"]).default("budget"),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    async ({ year, group_by, operating_unit, region, donor_country, sort_by, limit }) => {
      try {
        const summaries = await getJson<Row[]>(`/api/project_summary_${encodeURIComponent(year)}.json`);

        let rows = summaries;
        if (operating_unit) {
          const target = operating_unit.toUpperCase();
          rows = rows.filter((row) => String(row.operating_unit).toUpperCase() === target);
        }
        if (region) {
          const target = region.toUpperCase();
          rows = rows.filter((row) => String(row.region).toUpperCase() === target);
        }
        if (donor_country) {
          const target = donor_country.toUpperCase();
          rows = rows.filter((row) =>
            (row.donor_countries ?? []).some((code: string) => String(code).toUpperCase() === target),
          );
        }

        interface Bucket {
          key: string;
          budget: number;
          expenditure: number;
          projects: number;
        }
        const buckets = new Map<string, Bucket>();

        const add = (key: string, budget: number, expenditure: number) => {
          const label = key || "(unspecified)";
          const bucket = buckets.get(label) ?? { key: label, budget: 0, expenditure: 0, projects: 0 };
          bucket.budget += budget;
          bucket.expenditure += expenditure;
          bucket.projects += 1;
          buckets.set(label, bucket);
        };

        for (const row of rows) {
          const budget = toNumber(row.budget);
          const expenditure = toNumber(row.expenditure);

          switch (group_by) {
            case "operating_unit":
              add(row.operating_unit, budget, expenditure);
              break;
            case "region":
              add(row.region, budget, expenditure);
              break;
            case "crs":
              add(row.crs, budget, expenditure);
              break;
            case "core_vs_noncore":
              add(row.core ? "core" : "non-core", budget, expenditure);
              break;
            case "donor_country": {
              // A project can have several donors, each with its own share; use the
              // per-donor amounts so totals aren't multiplied across donors.
              const donors: string[] = row.donor_countries ?? [];
              donors.forEach((code, index) => {
                add(code, toNumber(row.donor_budget?.[index]), toNumber(row.donor_expend?.[index]));
              });
              break;
            }
            case "donor_type": {
              const types: string[] = row.donor_types ?? [];
              types.forEach((type, index) => {
                add(type, toNumber(row.donor_budget?.[index]), toNumber(row.donor_expend?.[index]));
              });
              break;
            }
          }
        }

        const sortKey = sort_by === "projects" ? "projects" : sort_by === "expenditure" ? "expenditure" : "budget";
        const groups = [...buckets.values()].sort((a, b) => b[sortKey] - a[sortKey]);

        return jsonResult({
          year,
          group_by,
          filters: { operating_unit, region, donor_country },
          projects_matched: rows.length,
          totals: {
            budget: round(rows.reduce((sum, row) => sum + toNumber(row.budget), 0)),
            expenditure: round(rows.reduce((sum, row) => sum + toNumber(row.expenditure), 0)),
          },
          group_count: groups.length,
          returned: Math.min(limit, groups.length),
          groups: groups.slice(0, limit).map((group) => ({
            ...group,
            budget: round(group.budget),
            expenditure: round(group.expenditure),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
