// Managed-auth integration for OpenAI Codex.
//
// Codex credentials are IMPORTED: the admin pastes either the contents of
// ~/.codex/auth.json (the file codex login writes) OR a bare personal access
// token (codex-rs AuthMode::PersonalAccessToken - a long-lived bearer token
// with no JWT structure, validated + identified via whoami instead of claim
// decoding, same bare-secret UX as Claude Code's sk-ant-oat01-… path). The
// integration validates whichever shape it got and hands it to
// ProviderAuthService.import(), which persists it through the normal
// encrypted provider-oauth store. Credentials with a refresh_token are
// automatically refreshed before expiry; personal access tokens never expire
// and have no refresh grant at all.
//
// Web-session tokens (__Secure-next-auth.session-token) are NOT supported
// because they are read-only on the Codex backend: they can list models but
// cannot run completions (/responses returns 401). Only real OAuth credentials
// from the codex CLI PKCE login (client_id app_EMoamEZ73f0CkXaXp7hrann) carry
// the correct audience and scope for the completion backend.

import type {
  ProviderAuthBeginResult,
  ProviderAuthCredential,
  ProviderAuthImport,
  ProviderAuthIntegration,
  ProviderAuthPollResult,
} from "../types";
import { NEVER_EXPIRES, ProviderReauthRequiredError } from "../types";
import type { ProviderTestProbe } from "../../../types/provider-auth";
import {
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_MODELS_URL,
  OPENAI_TOKEN_URL,
  OPENAI_WHOAMI_URL,
  codexRequestHeaders,
  parseCodexModels,
} from "../../../providers/codex";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000;

export function createCodexAuth(
  fetchImpl: typeof fetch = globalThis.fetch,
): ProviderAuthIntegration {
  return new CodexAuthIntegration(fetchImpl);
}

// --- shared payload -> credential assembly ----------------------------------

function credentialFromTokens(
  tokens: Record<string, unknown>,
  opts: {
    accessToken: string;
    expiresAt: number;
    context: string;
    hintAccountId?: string;
    hintEmail?: string;
    hintSubscriptionType?: string;
  },
): ProviderAuthCredential {
  const accessClaims = jwtClaims(opts.accessToken);
  const idToken =
    stringOrUndefined(tokens.id_token) ?? stringOrUndefined(tokens.idToken);
  const idClaims = claimsOf(idToken ?? "");
  const accountId = resolveAccountId(
    idClaims,
    accessClaims,
    stringOrUndefined(tokens.account_id) ?? stringOrUndefined(tokens.accountId),
    opts.hintAccountId,
  );
  if (!accountId) throw new Error(`${opts.context} lacks a ChatGPT account id`);
  return {
    integrationId: "codex",
    secrets: {
      accessToken: opts.accessToken,
      refreshToken:
        stringOrUndefined(tokens.refresh_token) ??
        stringOrUndefined(tokens.refreshToken),
      idToken,
    },
    expiresAt: opts.expiresAt,
    account: {
      accountId,
      email:
        stringOrUndefined(idClaims.email) ??
        stringOrUndefined(accessClaims.email) ??
        opts.hintEmail,
      label:
        stringOrUndefined(idClaims.name) ??
        stringOrUndefined(accessClaims.name),
      // Only the id_token carries this claim (see claimPlanType) - a refresh
      // response commonly omits id_token entirely, so fall back to whatever
      // plan was already on file rather than losing it on every rotation.
      subscriptionType: claimPlanType(idClaims) ?? opts.hintSubscriptionType,
    },
  };
}

function credentialFromPayload(
  payload: Record<string, unknown>,
  opts: {
    context: string;
    allowCookieExpiry?: boolean;
    fallbackRefreshToken?: string;
    fallbackIdToken?: string;
    fallbackAccountId?: string;
    fallbackSubscriptionType?: string;
  },
): ProviderAuthCredential {
  const accessToken =
    stringOrUndefined(payload.accessToken) ??
    stringOrUndefined(payload.access_token);
  if (!accessToken || !looksLikeJwt(accessToken))
    throw new Error(`${opts.context} did not return a valid access token JWT`);
  const accessClaims = jwtClaims(accessToken);
  if (!accessClaims.exp)
    throw new Error(`${opts.context} access token lacks an expiry`);
  const expiresAt = resolveExpiry(
    accessClaims,
    opts.allowCookieExpiry ? cookieExpiry(payload) : undefined,
  );
  const credential = credentialFromTokens(payload, {
    accessToken,
    expiresAt,
    context: opts.context,
    hintAccountId: opts.fallbackAccountId,
    hintSubscriptionType: opts.fallbackSubscriptionType,
  });
  if (opts.fallbackRefreshToken && !credential.secrets.refreshToken)
    credential.secrets.refreshToken = opts.fallbackRefreshToken;
  if (opts.fallbackIdToken && !credential.secrets.idToken)
    credential.secrets.idToken = opts.fallbackIdToken;
  return credential;
}

// codex-rs PersonalAccessTokenMetadata shape (auth/personal_access_token.rs).
interface WhoamiMetadata {
  email?: unknown;
  chatgpt_user_id?: unknown;
  chatgpt_account_id?: unknown;
  chatgpt_plan_type?: unknown;
}

// A Codex personal access token (codex-rs AuthMode::PersonalAccessToken) is a
// long-lived bearer token with no JWT structure to decode - identity comes
// from a whoami call instead, mirroring PersonalAccessTokenAuth::load().
// Never refreshes (no refresh_token exists for this mode at all).
async function credentialFromPersonalAccessToken(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<ProviderAuthCredential> {
  let res: Response;
  try {
    res = await boundedFetch(fetchImpl, OPENAI_WHOAMI_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
  } catch (error) {
    throw normalizeNetworkError(
      error,
      "Codex personal access token lookup failed",
    );
  }
  if (!res.ok) {
    const detail = await upstreamErrorDetail(res);
    throw new Error(
      `Codex personal access token was rejected (${res.status}${detail ? `: ${detail}` : ""})`,
    );
  }
  const payload = await readJsonLimited(res);
  const meta = payload as WhoamiMetadata;
  const accountId = stringOrUndefined(meta.chatgpt_account_id);
  if (!accountId)
    throw new Error("Codex personal access token lacks a ChatGPT account id");
  return {
    integrationId: "codex",
    secrets: { accessToken },
    expiresAt: NEVER_EXPIRES,
    account: {
      accountId,
      email: stringOrUndefined(meta.email),
      label: stringOrUndefined(meta.chatgpt_plan_type),
      tokenKind: "long_lived",
      authKind: "oauth_token",
      subscriptionType: stringOrUndefined(meta.chatgpt_plan_type),
    },
  };
}

// --- JWT helpers (payload decode only) -------------------------------------

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

interface JwtClaims extends Record<string, unknown> {
  exp?: unknown;
  email?: unknown;
  name?: unknown;
  account_id?: unknown;
  accountId?: unknown;
  organizations?: unknown;
}

interface DecodedJwtClaims extends JwtClaims {
  chatgpt_account_id?: unknown;
  "https://api.openai.com/auth"?: Record<string, unknown>;
  "https://api.openai.com/profile"?: Record<string, unknown>;
}

function claimsOf(token: string): DecodedJwtClaims {
  const empty: DecodedJwtClaims = {};
  if (!looksLikeJwt(token)) return empty;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") return empty;
    return parsed as DecodedJwtClaims;
  } catch {
    return empty;
  }
}

function jwtClaims(token: string): DecodedJwtClaims {
  return claimsOf(token);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveExpiry(claims: JwtClaims, earlierThan?: number): number {
  const exp = typeof claims.exp === "number" ? claims.exp : Number(claims.exp);
  if (!Number.isFinite(exp) || exp <= 0)
    throw new Error("Codex access token has no usable expiry");
  const expMs = exp < 10_000_000_000 ? exp * 1_000 : exp;
  const resolved =
    earlierThan !== undefined && earlierThan < expMs ? earlierThan : expMs;
  if (resolved <= Date.now())
    throw new Error(
      "Codex access token is expired; re-authenticate and import a fresh session",
    );
  return resolved;
}

function cookieExpiry(payload: Record<string, unknown>): number | undefined {
  const iso = stringOrUndefined(payload.expires);
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  const raw = payload.expiresAt;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw < 10_000_000_000 ? raw * 1_000 : raw;
  }
  return undefined;
}

function claimAccountId(claims: Record<string, unknown>): string | undefined {
  const authClaim = record(claims["https://api.openai.com/auth"]);
  return (
    stringOrUndefined(authClaim.chatgpt_account_id) ??
    stringOrUndefined(claims.chatgpt_account_id) ??
    firstOrganizationId(claims.organizations) ??
    stringOrUndefined(claims.account_id) ??
    stringOrUndefined(claims.accountId)
  );
}

// codex-rs's own known-plan display names (protocol/src/auth.rs KnownPlan::
// display_name) - lets a raw id_token claim value like "prolite" or
// "self_serve_business_prolite" render exactly the way the Codex CLI itself
// would, instead of a naive capitalize() mangling it. Anything not in this
// table (a plan codex-rs doesn't have a name for yet) falls back to a plain
// title-cased render of the raw value - never dropped, just less pretty.
const CODEX_PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_prolite: "Self Serve Business ProLite",
  self_serve_business_usage_based: "Self Serve Business Usage Based",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise CBP Usage Based",
  enterprise: "Enterprise",
  hc: "Enterprise",
  edu: "Edu",
  education: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

function planDisplayName(raw: string): string {
  const known = CODEX_PLAN_DISPLAY_NAMES[raw.toLowerCase()];
  if (known) return known;
  return raw
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

// The ChatGPT subscription plan, same claim path account id comes from
// (id_token's "https://api.openai.com/auth" claim - see codex-rs's
// login/src/token_data.rs parse_chatgpt_jwt_claims/IdTokenInfo, which reads
// this exact field to answer `codex login status`'s plan display). Never
// present on the access token, only the id_token.
function claimPlanType(claims: Record<string, unknown>): string | undefined {
  const authClaim = record(claims["https://api.openai.com/auth"]);
  const raw = stringOrUndefined(authClaim.chatgpt_plan_type);
  return raw ? planDisplayName(raw) : undefined;
}

function firstOrganizationId(value: unknown): string | undefined {
  const orgs = Array.isArray(value) ? value : [];
  const first = orgs[0];
  if (!first || typeof first !== "object") return undefined;
  return stringOrUndefined((first as Record<string, unknown>).id);
}

// Fixed priority, NOT "first string wins": an explicit account_id field beats
// both claim sets, but a JWT claim always beats the caller-supplied fallback.
// The fallback exists solely for refresh() - the OAuth refresh grant commonly
// omits id_token, and when it does the response carries no account info at
// all, so we carry forward the account id already on file (mirrors codex-rs
// persist_tokens(), which leaves account_id untouched when refresh doesn't
// return one). If the fallback were allowed to outrank a claim, a refresh
// response that DID include a fresh id_token but omitted a top-level
// account_id field would incorrectly prefer the stale fallback.
function resolveAccountId(
  idClaims: Record<string, unknown>,
  accessClaims: Record<string, unknown>,
  explicitAccountId: string | undefined,
  fallbackAccountId: string | undefined,
): string | undefined {
  return (
    stringOrUndefined(explicitAccountId) ??
    claimAccountId(idClaims) ??
    claimAccountId(accessClaims) ??
    stringOrUndefined(fallbackAccountId)
  );
}

// --- bounded HTTP plumbing ----------------------------------------------------

async function boundedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function readJsonLimited(
  res: Response,
): Promise<Record<string, unknown>> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    throw new Error("Authentication response too large");
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new Error("Authentication response too large");
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Authentication service returned invalid JSON");
  }
}

async function upstreamErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const detail = stringOrUndefined(obj.detail);
      if (detail) return detail.slice(0, 160);
      const err = record(obj.error);
      const message = stringOrUndefined(err.message);
      if (message) return message.slice(0, 160);
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
  } catch {
    return undefined;
  }
}

// OAuth token endpoint error shape: {"error": "invalid_grant", "error_description": "..."}.
// codex-rs's classify_refresh_token_failure() reads the same "error" code -
// see refresh_token_expired/reused/invalidated in codex-rs/login/src/auth/manager.rs.
function refreshErrorCode(
  payload: Record<string, unknown>,
): string | undefined {
  return stringOrUndefined(payload.error)?.toLowerCase();
}

function refreshErrorDetail(
  payload: Record<string, unknown>,
): string | undefined {
  const description = stringOrUndefined(payload.error_description);
  if (description) return description.slice(0, 160);
  const code = stringOrUndefined(payload.error);
  return code?.slice(0, 160);
}

// A refresh token that is dead and cannot be retried into working: OpenAI's
// classified expiry/reuse/revocation codes, a bare invalid_grant, or a 401
// (the token endpoint's generic "this credential is bad" signal). Everything
// else - 5xx, network errors, unexpected bodies, rate limiting - is treated
// as transient so a temporary hiccup at the auth server doesn't strand a
// working account behind a manual reconnect.
function isPermanentRefreshFailure(
  status: number,
  payload: Record<string, unknown>,
): boolean {
  if (status === 401) return true;
  const code = refreshErrorCode(payload);
  if (!code) return false;
  return (
    code === "invalid_grant" ||
    code === "refresh_token_expired" ||
    code === "refresh_token_reused" ||
    code === "refresh_token_invalidated"
  );
}

function normalizeNetworkError(error: unknown, context: string): Error {
  if (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "TimeoutError")
  ) {
    return new Error(`${context}: ${(error as Error).message}`);
  }
  return error instanceof Error ? error : new Error(context);
}

// --- integration ------------------------------------------------------------

class CodexAuthIntegration implements ProviderAuthIntegration {
  readonly id = "codex";
  readonly catalogId = "openai-codex";

  constructor(private readonly fetchImpl: typeof fetch) {}

  // Import-only integration: no interactive device flow.
  async begin(): Promise<ProviderAuthBeginResult> {
    throw new Error("OpenAI Codex does not support device authentication");
  }

  async poll(): Promise<ProviderAuthPollResult> {
    throw new Error("OpenAI Codex does not support device authentication");
  }

  async import(input: ProviderAuthImport): Promise<ProviderAuthCredential> {
    const value = input.value.trim();
    if (!value) throw new Error("Codex credential value is required");
    // A bare pasted secret (not JSON at all) is a personal access token
    // pasted directly, same UX as Claude Code's bare sk-ant-oat01-… path -
    // codex-rs's PersonalAccessTokenAuth is a long-lived bearer token with no
    // JWT structure, so there's nothing to parse here; whoami both validates
    // it and resolves identity. Real JSON (auth.json, a pasted session, or an
    // explicit personal_access_token field) keeps going through
    // importAuthJson exactly as before.
    let looksLikeJson = false;
    try {
      JSON.parse(value);
      looksLikeJson = true;
    } catch {
      looksLikeJson = false;
    }
    if (!looksLikeJson)
      return credentialFromPersonalAccessToken(this.fetchImpl, value);
    return this.importAuthJson(value);
  }

  async refresh(
    credential: ProviderAuthCredential,
  ): Promise<ProviderAuthCredential> {
    // Personal access tokens never expire and have no refresh grant at all
    // (codex-rs never calls the refresh endpoint for AuthMode::
    // PersonalAccessToken) - resolveManaged() shouldn't schedule this given
    // NEVER_EXPIRES, but guard defensively since refresh() can still be
    // invoked directly (e.g. testManaged's force-refresh path).
    if (credential.account.tokenKind === "long_lived") return credential;
    const refreshToken = credential.secrets.refreshToken;
    if (!refreshToken)
      throw new ProviderReauthRequiredError(
        "This Codex session has no refresh token; re-import the session",
      );
    let payload: Record<string, unknown>;
    try {
      const res = await boundedFetch(this.fetchImpl, OPENAI_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CODEX_CLIENT_ID,
        }),
      });
      payload = await readJsonLimited(res);
      if (!res.ok) {
        const detail = refreshErrorDetail(payload);
        if (isPermanentRefreshFailure(res.status, payload))
          throw new ProviderReauthRequiredError(
            `Codex refresh token is no longer valid (${res.status}${detail ? `: ${detail}` : ""}); re-import the session`,
          );
        throw new Error(
          `Codex token refresh failed (${res.status}${detail ? `: ${detail}` : ""})`,
        );
      }
    } catch (error) {
      if (error instanceof ProviderReauthRequiredError) throw error;
      throw normalizeNetworkError(error, "Codex token refresh failed");
    }
    const refreshed = credentialFromPayload(payload, {
      fallbackRefreshToken: refreshToken,
      fallbackIdToken: credential.secrets.idToken,
      fallbackAccountId: credential.account.accountId,
      fallbackSubscriptionType: credential.account.subscriptionType,
      context: "Codex refresh response",
    });
    // credentialFromPayload builds a fresh `account`, dropping the
    // classification fields set at import time (rotateProviderOAuth replaces
    // the whole row, so anything not carried forward here is lost on every
    // refresh cycle).
    refreshed.account.tokenKind = "oauth";
    refreshed.account.authKind = "oauth_token";
    return refreshed;
  }

  runtimeCredential(credential: ProviderAuthCredential): string {
    return credential.secrets.accessToken;
  }

  async test(credential: ProviderAuthCredential): Promise<ProviderTestProbe> {
    const started = Date.now();
    try {
      const res = await boundedFetch(
        this.fetchImpl,
        `${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`,
        {
          method: "GET",
          headers: codexRequestHeaders(
            credential.secrets.accessToken,
            credential.account.accountId,
            { accept: "application/json" },
          ),
        },
      );
      if (!res.ok) {
        const detail = await upstreamErrorDetail(res);
        return {
          ok: false,
          status: res.status,
          ms: Date.now() - started,
          error:
            res.status === 401
              ? `Codex rejected this credential (401${detail ? `: ${detail}` : ""}). Web-session tokens expire quickly and cannot be refreshed; run "codex login" and import ~/.codex/auth.json for a refreshable credential`
              : `Codex test failed (${res.status}${detail ? `: ${detail}` : ""})`,
          models: [],
        };
      }
      const models = parseCodexModels(await readJsonLimited(res));
      if (!models.length) {
        return {
          ok: false,
          status: res.status,
          ms: Date.now() - started,
          error: "Codex returned no usable models",
          models: [],
        };
      }
      return {
        ok: true,
        status: res.status,
        ms: Date.now() - started,
        models,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        ms: Date.now() - started,
        error: (error as Error).message,
        models: [],
      };
    }
  }

  private async importAuthJson(value: string): Promise<ProviderAuthCredential> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Codex auth JSON is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Codex auth JSON must be a single object");
    const root = parsed as Record<string, unknown>;

    // Personal access token mode (codex-rs AuthDotJson.personal_access_token,
    // resolved_mode(): explicit auth_mode wins, else the field's presence
    // implies AuthMode::PersonalAccessToken). Mutually exclusive with the
    // `tokens` JWT pair - check first and return early, no JWT parsing at all.
    const explicitPat =
      stringOrUndefined(root.personal_access_token) ??
      stringOrUndefined(root.personalAccessToken);
    if (explicitPat)
      return credentialFromPersonalAccessToken(this.fetchImpl, explicitPat);
    if (
      root.auth_mode === "personalAccessToken" ||
      root.authMode === "personalAccessToken"
    )
      throw new Error(
        "Codex auth JSON declares personalAccessToken mode but has no personal_access_token value",
      );

    const tokensRaw =
      root.tokens &&
      typeof root.tokens === "object" &&
      !Array.isArray(root.tokens)
        ? root.tokens
        : root;
    const tokens = tokensRaw as Record<string, unknown>;
    const accessToken =
      stringOrUndefined(tokens.access_token) ??
      stringOrUndefined(tokens.accessToken);
    if (!accessToken || !looksLikeJwt(accessToken))
      throw new Error("Codex auth JSON must contain a valid access token JWT");

    const accessClaims = jwtClaims(accessToken);
    if (!accessClaims.exp)
      throw new Error(
        "Codex auth JSON must contain a valid access token JWT with expiry",
      );
    const expiresAt = resolveExpiry(accessClaims, cookieExpiry(root));

    // Session JSON keeps identity outside `tokens`: account.id + user.*.
    const accountObject = record(root.account);
    const userObject = record(root.user);
    const hintAccountId =
      stringOrUndefined(tokens.account_id) ??
      stringOrUndefined(tokens.accountId) ??
      stringOrUndefined(accountObject.id);
    const hintEmail =
      stringOrUndefined(userObject.email) ?? stringOrUndefined(userObject.name);

    const credential = credentialFromTokens(tokens, {
      accessToken,
      expiresAt,
      context: "Codex auth JSON",
      hintAccountId,
      hintEmail,
    });
    credential.account.tokenKind = "oauth";
    credential.account.authKind = "oauth_token";
    return credential;
  }
}

export const codexAuth = createCodexAuth();
