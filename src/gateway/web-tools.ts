// Web-tool interception for Anthropic Messages requests.
//
// Anthropic's `web_search` / `web_fetch` are SERVER-SIDE (hosted) tools —
// Anthropic runs them and returns results inline. Most upstreams (e.g. 9router
// fronting arbitrary models) don't implement them. This module lets the gateway
// provide those tools itself, backed by Firecrawl:
//
//   1. detectWebTools()   — is the request asking for web_search / web_fetch?
//   2. rewriteRequest()   — swap the hosted tool DEFINITIONS for ordinary
//                           custom function tools the model can actually call
//                           (a normal `tool_use` block), so any model works.
//   3. executeWebTool()   — run a model's tool_use via Firecrawl and format the
//                           `tool_result` content to feed back into the loop.
//
// Everything here works in Anthropic Messages shape; the loop (web-tool-loop.ts)
// drives it. When Firecrawl errors we return an error tool_result rather than
// failing the request, so the model can recover gracefully.

import {
  firecrawlSearch,
  firecrawlScrape,
  type FirecrawlConfig,
} from "./firecrawl";

export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";

export interface WebToolsPresent {
  search: boolean;
  fetch: boolean;
}

// True when a tool definition is Anthropic's hosted web_search / web_fetch.
// Matches by the versioned `type` prefix ("web_search_20250305") or bare name.
function isHostedWebTool(t: Record<string, unknown>): "search" | "fetch" | null {
  const type = typeof t.type === "string" ? t.type : "";
  const name = typeof t.name === "string" ? t.name : "";
  if (type.startsWith("web_search") || name === WEB_SEARCH) return "search";
  if (type.startsWith("web_fetch") || name === WEB_FETCH) return "fetch";
  return null;
}

// Scan a Messages request body for hosted web tools.
export function detectWebTools(body: Record<string, unknown>): WebToolsPresent {
  const out: WebToolsPresent = { search: false, fetch: false };
  const tools = body.tools;
  if (!Array.isArray(tools)) return out;
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const kind = isHostedWebTool(tRaw as Record<string, unknown>);
    if (kind === "search") out.search = true;
    if (kind === "fetch") out.fetch = true;
  }
  return out;
}

// Custom function-tool definitions the model calls with a normal tool_use.
const SEARCH_DEF = {
  name: WEB_SEARCH,
  description:
    "Search the web for current information. Returns a list of results with " +
    "titles, URLs and short descriptions. Use it when you need up-to-date or " +
    "external facts.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
    },
    required: ["query"],
  },
};

const FETCH_DEF = {
  name: WEB_FETCH,
  description:
    "Fetch the readable text content of a web page by URL, as markdown. Use it " +
    "to read a specific page (e.g. one returned by web_search).",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The absolute URL to fetch." },
    },
    required: ["url"],
  },
};

// Replace hosted web tool defs with the custom function equivalents, leaving any
// other (client-provided) tools untouched. Also forces stream off for the loop.
// Returns a NEW body; the input is not mutated.
export function rewriteRequest(
  body: Record<string, unknown>,
  present: WebToolsPresent,
): Record<string, unknown> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const kept: unknown[] = [];
  for (const tRaw of tools) {
    if (tRaw && typeof tRaw === "object") {
      const kind = isHostedWebTool(tRaw as Record<string, unknown>);
      if (kind) continue; // drop hosted defs; replaced below
    }
    kept.push(tRaw);
  }
  if (present.search) kept.push(SEARCH_DEF);
  if (present.fetch) kept.push(FETCH_DEF);

  const out: Record<string, unknown> = { ...body, tools: kept };
  delete out.stream; // the loop runs non-streaming internally
  return out;
}

// Is this tool_use name one the gateway handles server-side?
export function isWebToolName(name: unknown): boolean {
  return name === WEB_SEARCH || name === WEB_FETCH;
}

// Execute one web tool call via Firecrawl. Returns the text to place in the
// tool_result content. Never throws — errors become an error string the model
// can read and react to.
export async function executeWebTool(
  cfg: FirecrawlConfig,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    if (name === WEB_SEARCH) {
      const query = String(input.query ?? "").trim();
      if (!query) return "Error: web_search requires a non-empty 'query'.";
      const results = await firecrawlSearch(cfg, query, { limit: 5 });
      if (!results.length) return `No results found for: ${query}`;
      return results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || "(no description)"}`,
        )
        .join("\n\n");
    }
    if (name === WEB_FETCH) {
      const url = String(input.url ?? "").trim();
      if (!url) return "Error: web_fetch requires a non-empty 'url'.";
      const page = await firecrawlScrape(cfg, url);
      const body = page.markdown || "(no readable content)";
      // Cap the fed-back content so one huge page can't blow up the next turn.
      const capped =
        body.length > 20_000
          ? `${body.slice(0, 20_000)}\n\n…[content truncated]`
          : body;
      return `# ${page.title}\n${page.url}\n\n${capped}`;
    }
    return `Error: unknown web tool '${name}'.`;
  } catch (err) {
    return `Error running ${name}: ${(err as Error).message}`;
  }
}
