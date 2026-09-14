/**
 * Donor tools.
 *
 * The donor index is ~37 MB and holds 6,000+ organisations, so it is only ever
 * searched, never returned wholesale. It is fetched once and cached; the first
 * call is slow, subsequent ones are instant.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getJson } from "../http.js";
import { errorResult, jsonResult, matchesQuery, paginate, round, toNumber } from "../format.js";

type Row = Record<string, any>;

export function registerDonorTools(server: McpServer): void {
  server.registerTool(
    "undp_search_donors",
    {
      title: "Search UNDP donors",
      description:
        "Search the index of organisations that fund UNDP (governments, multilaterals, foundations, " +
        "private sector) by name or id. A `query` is required — the full index holds thousands of donors " +
        "and is too large to list. Returns the donor id used as `budget_source` elsewhere.",
      inputSchema: {
        query: z.string().min(2).describe("Case-insensitive match on donor name or id, e.g. 'germany', 'gates'."),
        country: z.string().optional().describe("Filter by the donor's country code, e.g. 'DEU'."),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ query, country, limit, offset }) => {
      try {
        // ~37 MB on a cold cache; the client dedupes concurrent fetches.
        const donors = await getJson<Row[]>("/api/donor-index.json");

        let rows = donors.filter((donor) => matchesQuery(donor, query, ["id", "name"]));
        if (country) {
          const target = country.toUpperCase();
          rows = rows.filter((donor) => String(donor.country ?? "").toUpperCase() === target);
        }

        const page = paginate(rows, limit, offset);
        return jsonResult({
          query,
          index_size: donors.length,
          ...page,
          items: page.items.map((donor) => ({
            donor_id: donor.id,
            name: donor.name,
            country: donor.country,
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "undp_list_donor_countries",
    {
      title: "List UNDP donor countries",
      description:
        "List countries and territories that contribute funding to UNDP, with total budget and the " +
        "contributing organisations behind each. Use `query` to look one up, or list them ranked by " +
        "contribution.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive match on country name or iso3 code."),
        include_organisations: z
          .boolean()
          .default(false)
          .describe("Include each country's contributing organisations. Verbose — pair with `query`."),
        sort_by: z.enum(["budget", "name"]).default("budget"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ query, include_organisations, sort_by, limit, offset }) => {
      try {
        const countries = await getJson<Row[]>("/api/donor-country-index.json");

        const rows = countries
          .filter((country) => matchesQuery(country, query, ["id", "name"]))
          .map((country) => {
            const info: Row = country.additional_info ?? {};
            const organisations: Row[] = info.organisations ?? [];
            return {
              iso3: country.id,
              name: country.name,
              total_budget: round(toNumber(info.total_budget)),
              organisation_count: organisations.length,
              ...(include_organisations
                ? {
                    organisations: organisations.slice(0, 100).map((org) => ({
                      code: org.code,
                      name: org.name,
                      type: org.type,
                      donor_lvl: org.donor_lvl,
                      total_budget: round(toNumber(org.total_budget)),
                      is_donor: org.is_donor,
                      is_recipient: org.is_recipient,
                    })),
                  }
                : {}),
            };
          });

        rows.sort(
          sort_by === "name"
            ? (a, b) => String(a.name).localeCompare(String(b.name))
            : (a, b) => b.total_budget - a.total_budget,
        );

        return jsonResult({ query, ...paginate(rows, limit, offset) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
