// Managed-auth integration for OpenAI Codex.
//
// Codex credentials are IMPORTED: the admin pastes the contents of
// ~/.codex/auth.json (the file codex login writes). The integration validates
// the JWT pair and hands it to ProviderAuthService.import(), which persists
// it through the normal encrypted provider-oauth store. Credentials with a
// refresh_token are automatically refreshed before expiry.
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
import type { ProviderTestProbe } from "../../../types/provider-auth";
import {
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_MODELS_URL,
  OPENAI_TOKEN_URL,
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
  },
): ProviderAuthCredential {
  const accessClaims = jwtClaims(opts.accessToken);
  const idToken = stringOrUndefined(tokens.id_token) ??
    stringOrUndefined(tokens.idToken);
  const idClaims = claimsOf(idToken ?? "");
  const accountId = resolveAccountId(
    idClaims,
    accessClaims,
    stringOrUndefined(tokens.account_id) ??
      stringOrUndefined(tokens.accountId),
    opts.hintAccountId,
  );
  if (!accountId)
    throw new Error(`${opts.context} lacks a ChatGPT account id`);
  return {
    integrationId: "codex",
    secrets: {
      accessToken: opts.accessToken,
      refreshToken: stringOrUndefined(tokens.refresh_token) ??
        stringOrUndefined(tokens.refreshToken),
      idToken,
    },
    expiresAt: opts.expiresAt,
    account: {
      accountId,
      email: stringOrUndefined(idClaims.email) ??
        stringOrUndefined(accessClaims.email) ??
        opts.hintEmail,
      label: stringOrUndefined(idClaims.name) ??
        stringOrUndefined(accessClaims.name),
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
  },
): ProviderAuthCredential {
  const accessToken = stringOrUndefined(payload.accessToken) ??
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
  });
  if (opts.fallbackRefreshToken && !credential.secrets.refreshToken)
    credential.secrets.refreshToken = opts.fallbackRefreshToken;
  if (opts.fallbackIdToken && !credential.secrets.idToken)
    credential.secrets.idToken = opts.fallbackIdToken;
  return credential;
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
  return stringOrUndefined(authClaim.chatgpt_account_id) ??
    stringOrUndefined(claims.chatgpt_account_id) ??
    firstOrganizationId(claims.organizations) ??
    stringOrUndefined(claims.account_id) ??
    stringOrUndefined(claims.accountId);
}

function firstOrganizationId(value: unknown): string | undefined {
  const orgs = Array.isArray(value) ? value : [];
  const first = orgs[0];
  if (!first || typeof first !== "object") return undefined;
  return stringOrUndefined((first as Record<string, unknown>).id);
}

function resolveAccountId(
  ...sources: Array<Record<string, unknown> | string | undefined>
): string | undefined {
  const explicit = sources.find(
    (source): source is string =>
      typeof source === "string" && !!source.trim(),
  );
  if (explicit) return explicit;
  for (const source of sources) {
    if (source && typeof source === "object") {
      const found = claimAccountId(source);
      if (found) return found;
    }
  }
  return undefined;
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

async function upstreamErrorDetail(
  res: Response,
): Promise<string | undefined> {
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
    return this.importAuthJson(input.value);
  }

  async refresh(
    credential: ProviderAuthCredential,
  ): Promise<ProviderAuthCredential> {
    const refreshToken = credential.secrets.refreshToken;
    if (!refreshToken)
      throw new Error(
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
      if (!res.ok)
        throw new Error(`Codex token refresh failed (${res.status})`);
    } catch (error) {
      throw normalizeNetworkError(error, "Codex token refresh failed");
    }
    return credentialFromPayload(payload, {
      fallbackRefreshToken: refreshToken,
      fallbackIdToken: credential.secrets.idToken,
      context: "Codex refresh response",
    });
  }

  runtimeCredential(credential: ProviderAuthCredential): string {
    return credential.secrets.accessToken;
  }

  async test(
    credential: ProviderAuthCredential,
  ): Promise<ProviderTestProbe> {
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

  private async importAuthJson(
    value: string,
  ): Promise<ProviderAuthCredential> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Codex auth JSON is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Codex auth JSON must be a single object");
    const root = parsed as Record<string, unknown>;
    const tokensRaw =
      root.tokens && typeof root.tokens === "object" && !Array.isArray(root.tokens)
        ? root.tokens
        : root;
    const tokens = tokensRaw as Record<string, unknown>;
    const accessToken = stringOrUndefined(tokens.access_token) ??
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

    return credentialFromTokens(tokens, {
      accessToken,
      expiresAt,
      context: "Codex auth JSON",
      hintAccountId,
      hintEmail,
    });
  }
}

export const codexAuth = createCodexAuth();