/**
 * Helpers for turning large UNDP payloads into something a model can actually read.
 *
 * The guiding rule: never hand back a raw upstream document. Every list is
 * paginated, every free-text field is truncated, and a final size guard keeps a
 * surprise payload from swamping the context window.
 */

/** Hard ceiling on a tool result, in characters. */
const MAX_RESULT_CHARS = Number(process.env.UNDP_MAX_RESULT_CHARS ?? 100_000);

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  returned: number;
  has_more: boolean;
  /** Pass this back as `offset` to continue. Null when the page is the last one. */
  next_offset: number | null;
}

export function paginate<T>(items: T[], limit: number, offset: number): Page<T> {
  const start = Math.max(0, offset);
  const slice = items.slice(start, start + limit);
  const end = start + slice.length;

  return {
    items: slice,
    total: items.length,
    limit,
    offset: start,
    returned: slice.length,
    has_more: end < items.length,
    next_offset: end < items.length ? end : null,
  };
}

/** Collapse whitespace and cut a long description down to a readable stub. */
export function truncate(value: unknown, maxChars = 400): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… [truncated]`;
}

export function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in source) result[key] = source[key];
  }
  return result;
}

/** Case-insensitive "does any of these fields contain the query" test. */
export function matchesQuery(record: unknown, query: string | undefined, fields: string[]): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  const row = record as Record<string, unknown>;

  return fields.some((field) => {
    const value = row?.[field];
    return value !== undefined && value !== null && String(value).toLowerCase().includes(needle);
  });
}

export function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Round to 2dp so aggregates don't render as long floating-point tails. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Serialise a tool result, enforcing the size ceiling.
 *
 * Truncation here is a backstop, not a strategy — it means a tool failed to
 * narrow its own output, so the note tells the model how to recover.
 */
export function jsonResult(payload: unknown) {
  let text = JSON.stringify(payload, null, 2);

  if (text.length > MAX_RESULT_CHARS) {
    text = JSON.stringify(
      {
        error: "result_too_large",
        message:
          `The result was ${text.length} characters, over the ${MAX_RESULT_CHARS} limit. ` +
          "Narrow the request: use a smaller `limit`, add filters, or request summary output.",
        preview: `${text.slice(0, 2_000)}…`,
      },
      null,
      2,
    );
  }

  return { content: [{ type: "text" as const, text }] };
}

/** Render a thrown error as a tool error result rather than a transport failure. */
export function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
  };
}
