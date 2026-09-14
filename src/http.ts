/**
 * HTTP layer for the UNDP Open Data API.
 *
 * The API serves plain JSON with no auth, but several endpoints are very large
 * (the donor index is ~37 MB, a year of project summaries ~7 MB). Those are
 * static reference data, so we cache aggressively in memory and let the tool
 * layer slice them down before anything reaches the model.
 */

const BASE_URL = process.env.UNDP_API_BASE ?? "https://api.open.undp.org";
const USER_AGENT = "undp-open-data-mcp/1.0 (+https://api.open.undp.org)";

const REQUEST_TIMEOUT_MS = Number(process.env.UNDP_TIMEOUT_MS ?? 60_000);
const MAX_RETRIES = 2;

/** Default cache lifetime. The upstream data is refreshed on a slow cadence. */
const DEFAULT_TTL_MS = Number(process.env.UNDP_CACHE_TTL_MS ?? 60 * 60 * 1000);

/** An error that carries a message worth showing to the model. */
export class UndpApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "UndpApiError";
  }
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
/** In-flight requests, so concurrent tool calls share one fetch of a 37 MB file. */
const inflight = new Map<string, Promise<unknown>>();

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 404) {
        throw new UndpApiError("Not found — check that the id exists.", 404, url);
      }
      if (response.status === 400) {
        throw new UndpApiError(
          "The API rejected these parameters (400). Check the iso3 code, year, or filter values.",
          400,
          url,
        );
      }
      // Retry server-side failures; fail fast on other 4xx.
      if (response.status >= 500) {
        throw new UndpApiError(`Upstream error ${response.status}.`, response.status, url);
      }
      if (!response.ok) {
        throw new UndpApiError(`Request failed with status ${response.status}.`, response.status, url);
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      const retriable =
        !(error instanceof UndpApiError) || (error.status !== undefined && error.status >= 500);
      if (!retriable || attempt === MAX_RETRIES) break;

      await sleep(500 * 2 ** attempt);
    }
  }

  if (lastError instanceof UndpApiError) throw lastError;
  if (lastError instanceof Error && lastError.name === "TimeoutError") {
    throw new UndpApiError(
      `Request timed out after ${REQUEST_TIMEOUT_MS} ms. Some UNDP endpoints are tens of MB; retry or narrow the query.`,
      undefined,
      url,
    );
  }
  throw new UndpApiError(
    `Network error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    undefined,
    url,
  );
}

/**
 * GET a JSON document, served from cache when fresh.
 * `ttlMs: 0` bypasses the cache entirely.
 */
export async function getJson<T = unknown>(
  path: string,
  params?: Record<string, unknown>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const url = buildUrl(path, params);

  if (ttlMs > 0) {
    const hit = cache.get(url);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  }

  const pending = inflight.get(url);
  if (pending) return (await pending) as T;

  const request = fetchJson(url)
    .then((value) => {
      if (ttlMs > 0) cache.set(url, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, request);
  return (await request) as T;
}

export function clearCache(): void {
  cache.clear();
}

export function cacheStats(): { entries: number; urls: string[] } {
  return { entries: cache.size, urls: [...cache.keys()] };
}
