// Shared Claude Code OAuth protocol constants + helpers.
//
// Mirrors the layout used for Codex (./codex.ts): plain, dependency-light
// definitions consumed by BOTH the stock catalog adapter
// (./catalog/claude-code.ts) and the managed-auth integration
// (services/provider-auth/integrations/claude-code.ts), so client-identity
// values have exactly one home.
//
// Values pulled from the official Claude Code CLI source
// (src/constants/oauth.ts, src/services/oauth/client.ts, src/utils/http.ts,
// src/services/api/usage.ts, src/services/oauth/getOauthProfile.ts):
//   - CLIENT_ID / TOKEN_URL are the CLI's own production OAuth config
//     (getOauthConfig() PROD_OAUTH_CONFIG). TOKEN_URL is
//     platform.claude.com, NOT console.anthropic.com - that domain is stale
//     in older third-party writeups.
//   - OAUTH_BETA_HEADER is what getAuthHeaders() sends on every OAuth-token
//     request (as opposed to a plain API key, which sends x-api-key with no
//     beta header).
//   - The full ALL_OAUTH_SCOPES set is what a real interactive login
//     requests; CLAUDE_AI_INFERENCE_SCOPE alone is what the CLI calls (in
//     its own source comment) "Long-lived inference-only tokens" -
//     buildAuthUrl's `inferenceOnly` branch.

export const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
// OAuth token endpoint (authorization_code exchange + refresh_token grant).
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Account/org identity for an OAuth token (email, plan, org uuid). Requires
// user:profile scope - NOT available to a user:inference-only token.
export const CLAUDE_OAUTH_PROFILE_URL = `${CLAUDE_API_BASE_URL}/api/oauth/profile`;
// Proactive quota/reset query for an OAuth token. Same scope requirement as
// the profile endpoint - a user:inference-only token can't call this either
// (confirmed: such tokens can only be observed passively, via response
// headers on real inference calls - see unified-usage.ts).
export const CLAUDE_OAUTH_USAGE_URL = `${CLAUDE_API_BASE_URL}/api/oauth/usage`;
// Claude Code's public OAuth client id (constants/oauth.ts PROD_OAUTH_CONFIG).
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Enables OAuth bearer-token auth on /v1/messages (and friends) - required on
// every request authenticated with an OAuth-derived token, never sent for a
// plain x-api-key request.
export const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";

export const CLAUDE_AI_PROFILE_SCOPE = "user:profile";
export const CLAUDE_AI_INFERENCE_SCOPE = "user:inference";
// The scope set a real Claude.ai/Console interactive login requests
// (constants/oauth.ts CLAUDE_AI_OAUTH_SCOPES) - used as the refresh grant's
// default `scope` when a stored credential doesn't already carry its own.
export const CLAUDE_AI_OAUTH_SCOPES: readonly string[] = [
  CLAUDE_AI_PROFILE_SCOPE,
  CLAUDE_AI_INFERENCE_SCOPE,
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

// A bare pasted secret's prefix distinguishes an OAuth-derived token (needs
// Bearer + the oauth beta header) from a plain Console API key (needs
// x-api-key, no beta header) - the two are structurally identical strings
// otherwise, so detection at import time is the only place this can happen.
export const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat01-";

export function hasProfileScope(scopes: readonly string[] | undefined): boolean {
  return !!scopes?.includes(CLAUDE_AI_PROFILE_SCOPE);
}
