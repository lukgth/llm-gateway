// Managed-auth integration for Claude Code.
//
// Credentials are IMPORTED (same UX as Codex - see ./codex.ts): the admin
// pastes either the Claude Code OAuth credential JSON (the `claudeAiOauth`
// object from Claude Code's own secure token storage - a refreshable OAuth
// pair with a real expiry), OR a bare secret string - a long-lived
// `sk-ant-oat01-...` OAuth token (what Claude Code's own source calls
// "Long-lived inference-only tokens", CLAUDE_CODE_OAUTH_TOKEN-shaped, no
// refresh_token, never expires), OR a plain `sk-ant-api03-...` Console API
// key. The gateway detects which shape it got and manages refresh (for the
// first kind only) automatically from then on - the admin never has to
// think about it again.
//
// Full-scope OAuth credentials (user:profile) get account identity resolved
// via /api/oauth/profile and can query /api/oauth/usage for real quota
// windows. Long-lived user:inference-only tokens and plain API keys have
// neither: they're observed passively via response headers only (see
// services/anthropic/unified-usage.ts, already wired into the adapter).

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
  CLAUDE_AI_OAUTH_SCOPES,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_TOKEN_PREFIX,
  CLAUDE_OAUTH_TOKEN_URL,
  hasProfileScope,
} from "../../../providers/claude-code-oauth";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000;

export function createClaudeCodeAuth(
  fetchImpl: typeof fetch = globalThis.fetch,
): ProviderAuthIntegration {
  return new ClaudeCodeAuthIntegration(fetchImpl);
}

// --- shared helpers -----------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length ? out : undefined;
}

// Claude Code's own storage keeps `expiresAt` as an epoch-millisecond number
// (see the pasted claudeAiOauth shape - 1790298868888 - and
// utils/auth.ts/oauth/client.ts computing `Date.now() + expires_in * 1000`).
// Unlike Codex's JWT `exp` (seconds), there's no unit ambiguity to resolve.
function numberOrUndefined(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

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

async function readJsonLimited(res: Response): Promise<Record<string, unknown>> {
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
      const description = stringOrUndefined(obj.error_description);
      if (description) return description.slice(0, 160);
      const detail = stringOrUndefined(obj.detail);
      if (detail) return detail.slice(0, 160);
      const message = stringOrUndefined(obj.message);
      if (message) return message.slice(0, 160);
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
  } catch {
    return undefined;
  }
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

// OAuth token endpoint error shape (same convention as Codex's):
// {"error": "invalid_grant", "error_description": "..."}.
function refreshErrorCode(payload: Record<string, unknown>): string | undefined {
  return stringOrUndefined(payload.error)?.toLowerCase();
}

// A refresh token that is dead and cannot be retried into working: an
// explicit invalid_grant, or a 401 (the token endpoint's generic "this
// credential is bad" signal). Everything else - 5xx, network errors,
// unexpected bodies, rate limiting - is transient, so a temporary hiccup at
// the auth server doesn't strand a working account behind a manual
// reconnect. Same classification shape as codex.ts's isPermanentRefreshFailure.
function isPermanentRefreshFailure(
  status: number,
  payload: Record<string, unknown>,
): boolean {
  if (status === 401) return true;
  return refreshErrorCode(payload) === "invalid_grant";
}

// --- profile lookup -------------------------------------------------------

interface ProfileFields {
  accountUuid?: string;
  email?: string;
  displayName?: string;
  organizationUuid?: string;
}

// GET /api/oauth/profile - Bearer only, NO oauth beta header (confirmed
// against Claude Code's own getOauthProfileFromOauthToken - distinct from
// the inference-request header set). Only ever called for a credential that
// already reported user:profile scope; a token without it would just 401/403
// here, so callers gate on hasProfileScope() first rather than relying on
// this failing softly.
async function fetchProfile(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<ProfileFields | undefined> {
  let res: Response;
  try {
    res = await boundedFetch(fetchImpl, CLAUDE_OAUTH_PROFILE_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  let body: Record<string, unknown>;
  try {
    body = await readJsonLimited(res);
  } catch {
    return undefined;
  }
  const account = record(body.account);
  const organization = record(body.organization);
  return {
    accountUuid: stringOrUndefined(account.uuid),
    email: stringOrUndefined(account.email),
    displayName: stringOrUndefined(account.display_name),
    organizationUuid: stringOrUndefined(organization.uuid),
  };
}

// --- credential assembly --------------------------------------------------

interface ParsedOAuthBlob {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

// Unwraps the pasted JSON into a flat token blob, accepting both the
// wrapped `{"claudeAiOauth": {...}}` shape Claude Code's secure storage
// actually writes, and the bare inner object.
function parseOAuthBlob(root: Record<string, unknown>): ParsedOAuthBlob | undefined {
  const wrapped = record(root.claudeAiOauth);
  const flat = Object.keys(wrapped).length > 0 ? wrapped : root;
  const accessToken = stringOrUndefined(flat.accessToken) ?? stringOrUndefined(flat.access_token);
  if (!accessToken) return undefined;
  return {
    accessToken,
    refreshToken: stringOrUndefined(flat.refreshToken) ?? stringOrUndefined(flat.refresh_token),
    expiresAt: numberOrUndefined(flat.expiresAt) ?? numberOrUndefined(flat.expires_at),
    refreshTokenExpiresAt:
      numberOrUndefined(flat.refreshTokenExpiresAt) ??
      numberOrUndefined(flat.refresh_token_expires_at),
    scopes: stringArray(flat.scopes),
    subscriptionType: stringOrUndefined(flat.subscriptionType) ??
      stringOrUndefined(flat.subscription_type),
    rateLimitTier: stringOrUndefined(flat.rateLimitTier) ??
      stringOrUndefined(flat.rate_limit_tier),
  };
}

async function credentialFromOAuthBlob(
  fetchImpl: typeof fetch,
  blob: ParsedOAuthBlob,
): Promise<ProviderAuthCredential> {
  const isRefreshable = !!blob.refreshToken && !!blob.expiresAt;
  const scopes = blob.scopes ?? (isRefreshable ? undefined : ["user:inference"]);
  const profile = hasProfileScope(scopes)
    ? await fetchProfile(fetchImpl, blob.accessToken)
    : undefined;

  return {
    integrationId: "claude-code",
    secrets: {
      accessToken: blob.accessToken,
      refreshToken: blob.refreshToken,
    },
    expiresAt: isRefreshable ? blob.expiresAt! : NEVER_EXPIRES,
    account: {
      accountId: profile?.accountUuid,
      email: profile?.email,
      label: profile?.displayName,
      tokenKind: isRefreshable ? "oauth" : "long_lived",
      authKind: "oauth_token",
      scopes,
      subscriptionType: blob.subscriptionType,
      rateLimitTier: blob.rateLimitTier,
    },
  };
}

// A bare pasted secret string: either a long-lived sk-ant-oat01-... OAuth
// token, or a plain sk-ant-api03-... (or otherwise-shaped) Console API key.
// The prefix is the only signal available - there's no endpoint to probe
// that would tell them apart without spending a real request either way.
async function credentialFromBareSecret(
  fetchImpl: typeof fetch,
  secret: string,
): Promise<ProviderAuthCredential> {
  const isOAuthToken = secret.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX);
  const scopes = isOAuthToken ? ["user:inference"] : undefined;
  const profile = isOAuthToken && hasProfileScope(scopes)
    ? await fetchProfile(fetchImpl, secret)
    : undefined;
  return {
    integrationId: "claude-code",
    secrets: { accessToken: secret },
    expiresAt: NEVER_EXPIRES,
    account: {
      accountId: profile?.accountUuid,
      email: profile?.email,
      label: profile?.displayName,
      tokenKind: "long_lived",
      authKind: isOAuthToken ? "oauth_token" : "api_key",
      scopes,
    },
  };
}

// --- integration ------------------------------------------------------------

class ClaudeCodeAuthIntegration implements ProviderAuthIntegration {
  readonly id = "claude-code";
  readonly catalogId = "claude-code";

  constructor(private readonly fetchImpl: typeof fetch) {}

  // Import-only integration: no interactive device flow.
  async begin(): Promise<ProviderAuthBeginResult> {
    throw new Error("Claude Code does not support device authentication");
  }

  async poll(): Promise<ProviderAuthPollResult> {
    throw new Error("Claude Code does not support device authentication");
  }

  async import(input: ProviderAuthImport): Promise<ProviderAuthCredential> {
    const value = input.value.trim();
    if (!value) throw new Error("Claude Code credential value is required");

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const blob = parseOAuthBlob(parsed as Record<string, unknown>);
      if (blob) return credentialFromOAuthBlob(this.fetchImpl, blob);
      throw new Error(
        "Claude Code credential JSON must contain an accessToken (directly or under claudeAiOauth)",
      );
    }

    // Not JSON at all - treat the raw paste as a bare secret string.
    return credentialFromBareSecret(this.fetchImpl, value);
  }

  async refresh(
    credential: ProviderAuthCredential,
  ): Promise<ProviderAuthCredential> {
    // Long-lived credentials (inference-only OAuth tokens and plain API
    // keys) never expire and have no refresh grant at all.
    if (credential.account.tokenKind === "long_lived") return credential;
    const refreshToken = credential.secrets.refreshToken;
    if (!refreshToken)
      throw new ProviderReauthRequiredError(
        "This Claude Code session has no refresh token; re-import the credential",
      );

    const scopes: string[] = credential.account.scopes?.length
      ? credential.account.scopes
      : [...CLAUDE_AI_OAUTH_SCOPES];

    let payload: Record<string, unknown>;
    try {
      const res = await boundedFetch(this.fetchImpl, CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_CODE_CLIENT_ID,
          scope: scopes.join(" "),
        }),
      });
      payload = await readJsonLimited(res);
      if (!res.ok) {
        const detail = await upstreamErrorDetail(res).catch(() => undefined);
        if (isPermanentRefreshFailure(res.status, payload))
          throw new ProviderReauthRequiredError(
            `Claude Code refresh token is no longer valid (${res.status}${detail ? `: ${detail}` : ""}); re-import the credential`,
          );
        throw new Error(
          `Claude Code token refresh failed (${res.status}${detail ? `: ${detail}` : ""})`,
        );
      }
    } catch (error) {
      if (error instanceof ProviderReauthRequiredError) throw error;
      throw normalizeNetworkError(error, "Claude Code token refresh failed");
    }

    const accessToken = stringOrUndefined(payload.access_token);
    if (!accessToken)
      throw new Error("Claude Code refresh response did not return an access token");
    const expiresIn = numberOrUndefined(payload.expires_in);
    if (!expiresIn)
      throw new Error("Claude Code refresh response did not return expires_in");
    const newRefreshToken = stringOrUndefined(payload.refresh_token) ?? refreshToken;
    const grantedScopes = stringArray((stringOrUndefined(payload.scope) ?? "").split(" ")) ??
      scopes;

    // The refresh grant's response carries no account/org fields the way
    // Codex's does (see codex-rs persist_tokens - even there account_id is
    // only ever carried forward, never re-derived from a refresh). Re-fetch
    // the profile only if we don't already have identity cached, to avoid an
    // extra round-trip on every routine refresh - Claude Code's own client
    // does the same "skip re-fetch when already known" optimization for
    // exactly this reason (see refreshOAuthToken's haveProfileAlready guard).
    const needsProfile = hasProfileScope(grantedScopes) && !credential.account.accountId;
    const profile = needsProfile ? await fetchProfile(this.fetchImpl, accessToken) : undefined;

    return {
      integrationId: "claude-code",
      secrets: { accessToken, refreshToken: newRefreshToken },
      expiresAt: Date.now() + expiresIn * 1000,
      account: {
        accountId: profile?.accountUuid ?? credential.account.accountId,
        email: profile?.email ?? credential.account.email,
        label: profile?.displayName ?? credential.account.label,
        tokenKind: "oauth",
        authKind: "oauth_token",
        scopes: grantedScopes,
        subscriptionType: credential.account.subscriptionType,
        rateLimitTier: credential.account.rateLimitTier,
      },
    };
  }

  runtimeCredential(credential: ProviderAuthCredential): string {
    return credential.secrets.accessToken;
  }

  async test(credential: ProviderAuthCredential): Promise<ProviderTestProbe> {
    const started = Date.now();
    // Only a profile-scoped credential has a cheap, side-effect-free probe
    // endpoint available. A user:inference-only token or a plain API key has
    // no such endpoint - probing would mean spending a real inference call,
    // which this integration deliberately does not do (see class doc comment).
    if (!hasProfileScope(credential.account.scopes)) {
      return {
        ok: true,
        status: null,
        ms: Date.now() - started,
        error:
          "Imported - no cheap probe endpoint is available for this token's scope; usage is observed passively from real requests.",
        models: [],
      };
    }
    try {
      const res = await boundedFetch(this.fetchImpl, CLAUDE_OAUTH_PROFILE_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${credential.secrets.accessToken}` },
      });
      if (!res.ok) {
        const detail = await upstreamErrorDetail(res);
        return {
          ok: false,
          status: res.status,
          ms: Date.now() - started,
          error: `Claude Code credential check failed (${res.status}${detail ? `: ${detail}` : ""})`,
          models: [],
        };
      }
      return { ok: true, status: res.status, ms: Date.now() - started, models: [] };
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
}

export const claudeCodeAuth = createClaudeCodeAuth();
