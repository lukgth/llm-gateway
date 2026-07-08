// Firecrawl client — search + scrape. Keyless by default (the public API is
// currently usable without a key); an optional API key is sent only when one is
// configured in settings.
//
// Docs: https://docs.firecrawl.dev/  (v2 endpoints)
//   POST /v2/search  { query, limit, sources, scrapeOptions } -> { data: { web: [...] } }
//   POST /v2/scrape  { url, formats }                          -> { data: { markdown, metadata } }

import { requestJson } from "./http-json";

const DEFAULT_BASE = "https://api.firecrawl.dev";

export interface FirecrawlConfig {
  baseUrl?: string; // defaults to the public API
  apiKey?: string | null; // optional; keyless when absent
  timeoutMs?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  markdown?: string;
}

export interface FetchResult {
  url: string;
  title: string;
  markdown: string;
  statusCode?: number;
}

function authHeaders(cfg: FirecrawlConfig): Record<string, string> {
  return cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
}

// Run a web search. `scrape` pulls full markdown for each hit (costs more time)
// vs. just url/title/description.
export async function firecrawlSearch(
  cfg: FirecrawlConfig,
  query: string,
  opts: { limit?: number; scrape?: boolean } = {},
): Promise<SearchResult[]> {
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    query: String(query).slice(0, 500),
    limit: Math.min(Math.max(opts.limit ?? 5, 1), 20),
    sources: ["web"],
  };
  if (opts.scrape) body.scrapeOptions = { formats: ["markdown"] };

  const res = await requestJson({
    url: `${base}/v2/search`,
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
    timeoutMs: cfg.timeoutMs ?? 45_000,
  });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`firecrawl search ${res.status}: ${res.text.slice(0, 300)}`);

  const parsed = safeParse(res.text);
  const web = (parsed?.data?.web ?? parsed?.data ?? []) as unknown[];
  if (!Array.isArray(web)) return [];
  return web.slice(0, opts.limit ?? 5).map((rRaw) => {
    const r = (rRaw ?? {}) as Record<string, unknown>;
    return {
      title: str(r.title) || str(r.url) || "(untitled)",
      url: str(r.url),
      description: str(r.description),
      ...(str(r.markdown) ? { markdown: str(r.markdown) } : {}),
    };
  });
}

// Fetch a single URL's content as markdown.
export async function firecrawlScrape(
  cfg: FirecrawlConfig,
  url: string,
): Promise<FetchResult> {
  const base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const res = await requestJson({
    url: `${base}/v2/scrape`,
    headers: authHeaders(cfg),
    body: JSON.stringify({ url: String(url), formats: ["markdown"] }),
    timeoutMs: cfg.timeoutMs ?? 45_000,
  });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`firecrawl scrape ${res.status}: ${res.text.slice(0, 300)}`);

  const parsed = safeParse(res.text);
  const data = (parsed?.data ?? {}) as Record<string, unknown>;
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  return {
    url: str(meta.sourceURL) || String(url),
    title: str(meta.title) || String(url),
    markdown: str(data.markdown),
    ...(typeof meta.statusCode === "number"
      ? { statusCode: meta.statusCode }
      : {}),
  };
}

function safeParse(
  text: string,
): { data?: Record<string, unknown> & { web?: unknown } } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
