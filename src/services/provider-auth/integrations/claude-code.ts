// Managed-auth integration for Claude Code.
//
// Credentials are IMPORTED (same UX as Codex - see ./codex.ts): the admin
// pastes either the Claude Code OAuth credential JSON (the `claudeAiOauth`
// object from Claude Code's own secure token storage - a refreshable OAuth
// pair with a real expiry), OR a bare long-lived `sk-ant-oat01-...` OAuth
// token (what Claude Code's own source calls "Long-lived inference-only
// tokens", CLAUDE_CODE_OAUTH_TOKEN-shaped, no refresh_token, never expires).
// A plain `sk-ant-api03-...` Console API key is deliberately REJECTED here -
// that's the Anthropic provider's own credential shape (catalog/anthropic.ts,
// plain apiKeys table), not Claude Code's; Claude Code never issues that
// prefix, so accepting it here would just let a request silently pretend to
// be Claude Code traffic on a key that was never authorized for it. The
// gateway detects which shape it got and manages refresh (for the
// refreshable OAuth kind only) automatically from then on - the admin never
// has to think about it again.
//
// Every credential this integration accepts is validated with a real,
// side-effect-free upstream call before it's ever stored - never assumed
// valid from shape alone. Full-scope OAuth credentials (user:profile) are
// validated via /api/oauth/profile (which also resolves account identity);
// everything else (long-lived inference-only tokens) is validated via
// GET /v1/models, the one endpoint every credential kind here can reach
// without spending a real inference call. The same probe backs test().
//
// Full-scope OAuth credentials (user:profile) get account identity resolved
// via /api/oauth/profile and can query /api/oauth/usage for real quota
// windows. Long-lived user:inference-only tokens have neither: they're
// observed passively via response headers only (see
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
import type { AnthropicModelList, UpstreamModel } from "../../../formats/wire/models";
import { normalizeAnthropicModels } from "../../../providers/base/models";
import {
  ANTHROPIC_API_KEY_PREFIX,
  CLAUDE_AI_OAUTH_SCOPES,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_MODELS_URL,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_TOKEN_PREFIX,
  CLAUDE_OAUTH_TOKEN_URL,
  claudeProbeHeaders,
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

// --- models probe ----------------------------------------------------------
//
// GET /v1/models - the one cheap, side-effect-free endpoint every credential
// kind this integration accepts can reach (unlike /api/oauth/profile and
// /api/oauth/usage, gated on user:profile). Used to actually VALIDATE a
// freshly-pasted credential at import time - never assume shape alone means
// a token works - and reused by test() so both paths agree on what
// "reachable" means.
interface ModelsProbeResult {
  ok: boolean;
  status: number | null;
  models: UpstreamModel[];
  error?: string;
}

async function probeModels(
  fetchImpl: typeof fetch,
  accessToken: string,
  authKind: "api_key" | "oauth_token" | undefined,
): Promise<ModelsProbeResult> {
  let res: Response;
  try {
    res = await boundedFetch(fetchImpl, CLAUDE_MODELS_URL, {
      method: "GET",
      headers: claudeProbeHeaders(accessToken, authKind),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      models: [],
      error: normalizeNetworkError(error, "Claude Code credential check failed").message,
    };
  }
  if (!res.ok) {
    const detail = await upstreamErrorDetail(res);
    return {
      ok: false,
      status: res.status,
      models: [],
      error: `Claude Code credential check failed (${res.status}${detail ? `: ${detail}` : ""})`,
    };
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonLimited(res);
  } catch {
    return {
      ok: false,
      status: res.status,
      models: [],
      error: "Claude Code returned an invalid model list",
    };
  }
  const models = normalizeAnthropicModels(body as AnthropicModelList);
  return { ok: true, status: res.status, models };
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

  // Validate the pasted credential with a real upstream call before ever
  // storing it - never assume it's good just because it parsed. A
  // profile-scoped credential gets identity resolved AND validated in one
  // call (a failed fetch means a bad/expired token, not "no identity
  // available"); anything else falls back to the same cheap /v1/models probe
  // credentialFromBareSecret uses.
  let profile: ProfileFields | undefined;
  if (hasProfileScope(scopes)) {
    profile = await fetchProfile(fetchImpl, blob.accessToken);
    if (!profile)
      throw new Error(
        "Claude Code rejected this credential (profile check failed) - it may be expired or revoked",
      );
  } else {
    const probe = await probeModels(fetchImpl, blob.accessToken, "oauth_token");
    if (!probe.ok)
      throw new Error(probe.error ?? "Claude Code rejected this credential");
  }

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

// A bare pasted secret string: only a long-lived sk-ant-oat01-... OAuth
// token is accepted here. A plain sk-ant-api03-... Console key is the
// Anthropic provider's own credential shape (catalog/anthropic.ts) - Claude
// Code never issues that prefix, so it's rejected outright rather than
// silently stored as a "plain API key" Claude Code credential (see this
// module's header comment). Whatever's left is validated with a real
// GET /v1/models call before being accepted - never assumed valid from
// shape alone.
async function credentialFromBareSecret(
  fetchImpl: typeof fetch,
  secret: string,
): Promise<ProviderAuthCredential> {
  if (secret.startsWith(ANTHROPIC_API_KEY_PREFIX))
    throw new Error(
      "This is an Anthropic Console API key (sk-ant-api...), not a Claude Code credential. " +
        "Add it under the Anthropic provider instead, or paste a Claude Code OAuth token (sk-ant-oat01-...) or credential JSON here.",
    );
  if (!secret.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX))
    throw new Error(
      "Claude Code only accepts credential JSON (the claudeAiOauth object) or a bare sk-ant-oat01-… OAuth token.",
    );

  const scopes = ["user:inference"];
  const probe = await probeModels(fetchImpl, secret, "oauth_token");
  if (!probe.ok)
    throw new Error(probe.error ?? "Claude Code rejected this credential");

  return {
    integrationId: "claude-code",
    secrets: { accessToken: secret },
    expiresAt: NEVER_EXPIRES,
    account: {
      tokenKind: "long_lived",
      authKind: "oauth_token",
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
    // A profile-scoped credential gets the richer /api/oauth/profile check
    // (also confirms identity); everything else (long-lived user:inference-
    // only tokens, and legacy migrated plain API keys) falls back to the
    // same GET /v1/models probe import-time validation uses - a real
    // upstream round-trip either way, never a hand-waved "ok: true" without
    // actually checking the credential works.
    if (!hasProfileScope(credential.account.scopes)) {
      const probe = await probeModels(
        this.fetchImpl,
        credential.secrets.accessToken,
        credential.account.authKind,
      );
      return {
        ok: probe.ok,
        status: probe.status,
        ms: Date.now() - started,
        ...(probe.error ? { error: probe.error } : {}),
        models: probe.models,
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
