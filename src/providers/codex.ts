// Shared OpenAI Codex backend protocol constants + helpers.
//
// Mirrors the layout used for Cline (../clinefree.ts): plain, dependency-light
// definitions consumed by BOTH the stock catalog adapter (./catalog/openai-codex.ts)
// and the managed-auth integration (services/provider-auth/integrations/codex.ts),
// so client-identity values have exactly one home.
//
// Everything here replicates the official Codex CLI's outbound behavior
// (openai/codex codex-rs sources):
//   - default_client.rs      : originator + user-agent defaults
//   - model-provider-info    : version header + CHATGPT_CODEX_BASE_URL
//   - bearer_auth_provider.rs: Authorization + ChatGPT-Account-Id headers
//   - endpoint/models.rs     : GET /models?client_version=...

import os from "os";
import type { UpstreamModel } from "../formats/wire/models";

export const CODEX_API_BASE_URL = "https://chatgpt.com";
export const CODEX_BASE_PATH = "/backend-api/codex";
export const CODEX_MODELS_URL = `${CODEX_API_BASE_URL}${CODEX_BASE_PATH}/models`;
// Server-side exchange of a pasted browser session cookie for OAuth tokens.
export const CHATGPT_SESSION_URL = `${CODEX_API_BASE_URL}/api/auth/session`;
// OAuth token endpoint used for refresh_token grants (codex-rs login manager).
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Codex CLI's public OAuth client id - required by the refresh grant.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// DEFAULT_ORIGINATOR from codex-rs default_client.rs - the originator header
// value and user-agent prefix.
export const CODEX_ORIGINATOR = "codex_cli_rs";
// Browser cookie whose VALUE is exchanged at CHATGPT_SESSION_URL. Only the
// value is ever handled server-side; the cookie itself is never stored.
export const CHATGPT_SESSION_COOKIE_NAME = "__Secure-next-auth.session-token";
// Codex CLI browser-login OAuth: localhost callback + issuer (see codex-rs
// login/server.rs - DEFAULT_PORT 1455, authorize at auth.openai.com).
export const CODEX_LOGIN_PORT = 1455;
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_LOGIN_PORT}/auth/callback`;
export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";
// Browser-context User-Agent for the chatgpt.com/api/auth/session exchange.
// That endpoint is browser-facing behind Cloudflare; a Node/server UA makes a
// challenge near-certain even when valid clearance cookies ride along.
export const CHATGPT_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// Cloudflare SERVICE cookies that may accompany a pasted session-cookie line
// (allowlist mirrors codex-rs http-client/src/chatgpt_cloudflare_cookies.rs).
// They are replayed on the exchange request because chatgpt.com serves the
// session JSON only when prior challenge clearance rides along.
export const CLOUDFLARE_COOKIE_NAMES: readonly string[] = [
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
];
export function isCloudflareCookieName(name: string): boolean {
  return CLOUDFLARE_COOKIE_NAMES.includes(name) || name.startsWith("cf_chl_");
}

// Pinned to the currently published @openai/codex npm version. Used for the
// version header, the user-agent, and the models client_version query. If the
// backend starts rejecting the pinned identity, bump this ONE constant.
export const CODEX_CLIENT_VERSION = "0.149.0";
// reqwest version pinned by codex-rs' Cargo.lock; the trailing segment of the
// CLI's User-Agent string.
const CODEX_REQWEST_VERSION = "0.12.28";

function codexOsSegment(): string {
  // get_codex_user_agent(): "({os_type} {os_version}; {arch})".
  const osType =
    process.platform === "darwin"
      ? "Mac OS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";
  const arch = os.arch() === "arm64" ? "arm64" : "x86_64";
  return `${osType} ${os.release()}; ${arch}`;
}

// codex-rs get_codex_user_agent():
//   "{originator}/{version} ({os_type} {os_ver}; {arch}) reqwest/{reqwest}"
export function codexUserAgent(): string {
  return `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (${codexOsSegment()}) reqwest/${CODEX_REQWEST_VERSION}`;
}

// The client-identity headers every authenticated Codex backend request
// carries, minus Authorization/chatgpt-account-id which depend on the selected
// credential and ride along per-request.
export function codexIdentityHeaders(): Record<string, string> {
  return {
    originator: CODEX_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    "user-agent": codexUserAgent(),
  };
}

// Full identity + auth header set for a specific Codex credential: identity
// headers, bearer Authorization, and chatgpt-account-id (the backend resolves
// subscription scope from it - requests without it fail).
export function codexRequestHeaders(
  accessToken: string,
  accountId?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...extra,
    ...codexIdentityHeaders(),
    authorization: `Bearer ${accessToken}`,
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
  };
}

// Parse + filter the Codex model catalog ({ models: [ModelInfo] }) down to
// PUBLIC API-usable entries: a non-empty slug, not opted out of the API
// (supported_in_api !== false), and visible (visibility absent or "list").
// Malformed entries are skipped silently; callers decide what empty means.
export function parseCodexModels(body: unknown): UpstreamModel[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: UpstreamModel[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.slug !== "string" || !entry.slug.trim()) continue;
    if (entry.supported_in_api === false) continue;
    const visibility =
      typeof entry.visibility === "string"
        ? entry.visibility.toLowerCase()
        : undefined;
    if (visibility && visibility !== "list") continue;
    out.push({
      id: entry.slug,
      displayName:
        typeof entry.display_name === "string" && entry.display_name.trim()
          ? entry.display_name
          : entry.slug,
      ...(typeof entry.context_window === "number" &&
      Number.isFinite(entry.context_window) &&
      entry.context_window > 0
        ? { contextWindow: entry.context_window }
        : {}),
      raw: entry,
    });
  }
  return out;
}
