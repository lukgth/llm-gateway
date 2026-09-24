import type { ProviderTestProbe } from "../../types/provider-auth";

// Thrown by integration.refresh() when the refresh token itself is dead
// (expired/revoked/reused, or the upstream OAuth server returned an
// unambiguous invalid_grant/401) and no retry can succeed - the operator
// must reconnect. Any other refresh() failure (network error, 5xx, timeout,
// malformed response) is transient: ProviderCredentialService leaves the
// stored credential alone so the next call can retry, matching how the
// Codex CLI itself only forces re-login on a classified-permanent failure.
export class ProviderReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderReauthRequiredError";
  }
}

export type ProviderAuthState =
  | "pending"
  | "ready"
  | "denied"
  | "expired"
  | "failed"
  | "cancelled"
  | "consumed";

export interface ProviderAuthSecrets {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

// Non-secret classification + display metadata about a credential. Lives on
// `account` (not `secrets`) because it flows through the PUBLIC, unencrypted
// side of the store (provider_oauth_credentials.public_metadata -
// JSON.stringify(credential.account), see repo/provider-oauth.ts) that
// session/admin views already read - unlike `secrets`, which is encrypted
// and never reaches the frontend except the one admin-only raw-token field.
export interface ProviderAuthAccount {
  accountId?: string;
  email?: string;
  label?: string;
  /**
   * Explicit credential shape, not inferred from refreshToken's absence (a
   * refreshable OAuth credential can legitimately be missing one transiently
   * after a refresh response omits it - see codex.ts's fallbackRefreshToken).
   * Omitted / "oauth" = normal refreshable OAuth pair, has a real expiry.
   * "long_lived" = structurally never expires and never refreshes - a Codex
   * personal access token (codex-rs AuthMode::PersonalAccessToken), a Claude
   * Code user:inference-only token (CLAUDE_CODE_OAUTH_TOKEN-shaped, no
   * refresh_token), or a plain vendor API key routed through managed-auth
   * storage. ProviderCredentialService.resolveManaged() skips the
   * refresh-scheduling path entirely for "long_lived" (via NEVER_EXPIRES).
   */
  tokenKind?: "oauth" | "long_lived";
  /**
   * Which wire auth this secret needs - orthogonal to tokenKind (a
   * long-lived secret can be either kind). "api_key" = vendor's plain API-key
   * header scheme (e.g. Anthropic x-api-key). "oauth_token" = bearer token
   * requiring OAuth-specific headers (e.g. Anthropic's `anthropic-beta:
   * oauth-2025-04-20`). Undefined when not applicable (integrations with a
   * single fixed auth scheme, e.g. Codex's bearer-only backend).
   */
  authKind?: "api_key" | "oauth_token";
  /** OAuth scopes actually granted, when known (drives usage-endpoint
   *  eligibility - e.g. Claude Code's /api/oauth/usage needs user:profile). */
  scopes?: string[];
  /** Upstream subscription/plan label, when known (e.g. "pro", "max",
   *  "enterprise", or a ChatGPT plan type) - surfaced in the usage view. */
  subscriptionType?: string;
  /** Upstream rate-limit tier, when reported (e.g. Claude's
   *  "default_claude_ai"). Informational only. */
  rateLimitTier?: string;
  /** Free-form operator tags, same shape and purpose as a plain provider
   *  key's `metadata` (repo/provider-keys.ts) - never written by an
   *  integration, only by the admin through the accounts table's tag editor.
   *  Preserved across refresh()/rotateProviderOAuth (see repo/provider-oauth.ts
   *  rotateProviderOAuth's explicit carry-forward), so re-authenticating an
   *  account never silently drops tags the admin set on it. */
  tags?: Record<string, string>;
}

export interface ProviderAuthCredential {
  integrationId: string;
  secrets: ProviderAuthSecrets;
  expiresAt: number;
  account: ProviderAuthAccount;
}

// Sentinel `expiresAt` for a `tokenKind: "long_lived"` credential - a real
// timestamp (rather than null/undefined) keeps every existing `expiresAt <=
// Date.now() + N` comparison correct without special-casing every call site
// (ProviderAuthService.import's expiry check, ProviderCredentialService.
// resolveManaged's refresh-due check, provider-oauth.ts's `expiresAt` column)
// - "never due" falls out of the comparison itself.
//
// NOT Number.MAX_SAFE_INTEGER (9_007_199_254_740_991): that's larger than
// JavaScript's own valid Date range (+/-8_640_000_000_000_000 ms from the
// epoch, ECMA-262 Date Time Limits) and `new Date(...).toISOString()` throws
// a RangeError on anything past it - repo/provider-oauth.ts's mapView() does
// exactly that on every read. This is the actual max valid Date instead
// (year 275760) - still "never" in every practical sense.
export const NEVER_EXPIRES = 8_640_000_000_000_000;

export interface ProviderAuthBeginResult {
  transaction: unknown;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}

export type ProviderAuthPollResult =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "denied"; message: string }
  | { state: "expired"; message: string }
  | { state: "failed"; message: string }
  | { state: "ready"; credential: ProviderAuthCredential };

// A credential supplied directly by an administrator instead of acquired
// through an interactive flow - e.g. pasting an existing auth.json or a raw
// session cookie. Only integrations that declare `import` accept these.
export interface ProviderAuthImport {
  kind: "auth_json" | "session_cookie" | "callback_url";
  value: string;
}

export interface ProviderAuthIntegration {
  id: string;
  catalogId: string;
  begin(): Promise<ProviderAuthBeginResult>;
  poll(transaction: unknown): Promise<ProviderAuthPollResult>;
  refresh(credential: ProviderAuthCredential): Promise<ProviderAuthCredential>;
  runtimeCredential(credential: ProviderAuthCredential): string;
  test(credential: ProviderAuthCredential): Promise<ProviderTestProbe>;
  import?(input: ProviderAuthImport): Promise<ProviderAuthCredential>;
}

export interface ProviderAuthSessionView {
  id: string;
  catalogId: string;
  state: ProviderAuthState;
  flow: "device_code" | "import";
  expiresAt: string;
  nextPollAt?: string;
  verification?: {
    uri: string;
    uriComplete?: string;
    userCode: string;
  };
  account?: ProviderAuthAccount;
  error?: { code: string; message: string };
}
