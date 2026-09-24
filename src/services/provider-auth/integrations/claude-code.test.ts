// Claude Code managed-auth integration tests: credential-shape detection on
// import (OAuth JSON, wrapped claudeAiOauth, bare long-lived token, bare
// plain API key), refresh classification, and the test probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaudeCodeAuth } from "./claude-code";
import { NEVER_EXPIRES, type ProviderAuthCredential } from "../types";
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_MODELS_URL,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
} from "../../../providers/claude-code-oauth";

function fakeFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });
    return handler(urlStr, init);
  }) as typeof fetch;
  return { fetchImpl: fn, calls };
}

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function assertNoSecrets(error: unknown, ...secrets: string[]): void {
  const message = (error as Error).message;
  for (const secret of secrets)
    assert.equal(message.includes(secret), false, `leaked: ${secret}`);
}

const FULL_OAUTH_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-access-value",
    refreshToken: "sk-ant-ort01-refresh-value",
    expiresAt: Date.now() + 60 * 60_000,
    refreshTokenExpiresAt: Date.now() + 365 * 24 * 60 * 60_000,
    scopes: [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:plugins",
      "user:profile",
      "user:sessions:claude_code",
    ],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
});

function profileResponse(): Response {
  return jsonRes(200, {
    account: {
      uuid: "acct-uuid-1",
      email: "user@example.com",
      display_name: "Test User",
    },
    organization: { uuid: "org-uuid-1" },
  });
}

function modelsResponse(): Response {
  return jsonRes(200, {
    data: [
      {
        id: "claude-opus-4-6",
        type: "model",
        display_name: "Claude Opus 4.6",
        created_at: "2025-01-01T00:00:00Z",
      },
    ],
  });
}

// Import (and refresh, for a non-profile-scoped credential) now validates
// every credential with a real upstream call before accepting it - a
// profile-scoped one via /api/oauth/profile, everything else via
// GET /v1/models. Tests that don't care about validation route both
// endpoints to a success response.
function fakeFetchAlwaysOk(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  return fakeFetch((url) =>
    url === CLAUDE_MODELS_URL ? modelsResponse() : profileResponse(),
  );
}

// --- import: full OAuth JSON -------------------------------------------------

test("claude-code import parses full OAuth JSON, resolves profile identity, and preserves scopes", async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    assert.equal(url, CLAUDE_OAUTH_PROFILE_URL);
    return profileResponse();
  });
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: FULL_OAUTH_JSON,
  });
  assert.equal(credential.integrationId, "claude-code");
  assert.equal(credential.secrets.accessToken, "sk-ant-oat01-access-value");
  assert.equal(credential.secrets.refreshToken, "sk-ant-ort01-refresh-value");
  assert.equal(credential.account.tokenKind, "oauth");
  assert.equal(credential.account.authKind, "oauth_token");
  assert.equal(credential.account.accountId, "acct-uuid-1");
  assert.equal(credential.account.email, "user@example.com");
  assert.equal(credential.account.label, "Test User");
  assert.equal(credential.account.subscriptionType, "pro");
  assert.equal(credential.account.rateLimitTier, "default_claude_ai");
  assert.deepEqual(credential.account.scopes, [
    "user:file_upload",
    "user:inference",
    "user:mcp_servers",
    "user:plugins",
    "user:profile",
    "user:sessions:claude_code",
  ]);
  assert.equal(credential.expiresAt > Date.now(), true);
  assert.equal(credential.expiresAt < NEVER_EXPIRES, true);
  // Profile call used Bearer only, no oauth beta header (distinct from
  // inference requests).
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-ant-oat01-access-value");
  assert.equal(headers["anthropic-beta"], undefined);
});

test("claude-code import accepts the bare (unwrapped) claudeAiOauth object", async () => {
  const { fetchImpl } = fakeFetch(() => profileResponse());
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const inner = JSON.parse(FULL_OAUTH_JSON).claudeAiOauth;
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: JSON.stringify(inner),
  });
  assert.equal(credential.account.tokenKind, "oauth");
  assert.equal(credential.account.accountId, "acct-uuid-1");
});

test("claude-code import skips the profile call when scopes lack user:profile, validating via /v1/models instead", async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    assert.equal(url, CLAUDE_MODELS_URL);
    return modelsResponse();
  });
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const withoutProfile = JSON.parse(FULL_OAUTH_JSON);
  withoutProfile.claudeAiOauth.scopes = ["user:inference"];
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: JSON.stringify(withoutProfile),
  });
  assert.equal(calls.length, 1);
  assert.equal(credential.account.accountId, undefined);
  assert.equal(credential.account.tokenKind, "oauth"); // still refreshable - has refreshToken+expiresAt
});

test("claude-code import rejects JSON with no accessToken field", async () => {
  const claudeCode = createClaudeCodeAuth();
  await assert.rejects(
    () =>
      claudeCode.import!({
        kind: "auth_json",
        value: JSON.stringify({ claudeAiOauth: { refreshToken: "r" } }),
      }),
    /accessToken/,
  );
});

// --- import: bare secret strings ---------------------------------------------

test("claude-code import treats a bare sk-ant-oat01- token as long-lived OAuth, validated via /v1/models", async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    assert.equal(url, CLAUDE_MODELS_URL);
    return modelsResponse();
  });
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-oat01-bare-long-lived-token",
  });
  assert.equal(
    credential.secrets.accessToken,
    "sk-ant-oat01-bare-long-lived-token",
  );
  assert.equal(credential.secrets.refreshToken, undefined);
  assert.equal(credential.account.tokenKind, "long_lived");
  assert.equal(credential.account.authKind, "oauth_token");
  assert.deepEqual(credential.account.scopes, ["user:inference"]);
  assert.equal(credential.expiresAt, NEVER_EXPIRES);
  assert.equal(calls.length, 1);
  // Bearer + oauth beta header, not x-api-key.
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(
    headers.authorization,
    "Bearer sk-ant-oat01-bare-long-lived-token",
  );
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
});

test("claude-code import rejects an invalid bare sk-ant-oat01- token (failed /v1/models probe)", async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonRes(401, {
      error: { type: "authentication_error", message: "invalid" },
    }),
  );
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  await assert.rejects(
    () =>
      claudeCode.import!({
        kind: "auth_json",
        value: "sk-ant-oat01-dead-token",
      }),
    /401/,
  );
});

test("claude-code import REJECTS a bare sk-ant-api03- key - that's the Anthropic provider's credential, not Claude Code's", async () => {
  const claudeCode = createClaudeCodeAuth();
  await assert.rejects(
    () =>
      claudeCode.import!({
        kind: "auth_json",
        value: "sk-ant-api03-plain-console-key",
      }),
    /Anthropic Console API key/,
  );
});

test("claude-code import rejects an empty paste", async () => {
  const claudeCode = createClaudeCodeAuth();
  await assert.rejects(() =>
    claudeCode.import!({ kind: "auth_json", value: "   " }),
  );
});

// --- refresh -----------------------------------------------------------------

test("claude-code refresh posts the exact OAuth body and rotates tokens", async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url === CLAUDE_OAUTH_TOKEN_URL)
      return jsonRes(200, {
        access_token: "sk-ant-oat01-refreshed",
        refresh_token: "sk-ant-ort01-refreshed",
        expires_in: 3600,
        scope: "user:profile user:inference",
      });
    return profileResponse();
  });
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const original = await claudeCode.import!({
    kind: "auth_json",
    value: FULL_OAUTH_JSON,
  });
  const refreshed = await claudeCode.refresh(original);

  const tokenCall = calls.find((c) => c.url === CLAUDE_OAUTH_TOKEN_URL)!;
  const body = JSON.parse(String(tokenCall.init.body)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(body, {
    grant_type: "refresh_token",
    refresh_token: "sk-ant-ort01-refresh-value",
    client_id: CLAUDE_CODE_CLIENT_ID,
    scope: original.account.scopes!.join(" "),
  });
  assert.equal(refreshed.secrets.accessToken, "sk-ant-oat01-refreshed");
  assert.equal(refreshed.secrets.refreshToken, "sk-ant-ort01-refreshed");
  assert.equal(refreshed.account.tokenKind, "oauth");
  // Already had accountId from import - refresh should NOT re-fetch profile.
  const profileCallsDuringRefresh = calls.filter(
    (c) => c.url === CLAUDE_OAUTH_PROFILE_URL,
  ).length;
  assert.equal(profileCallsDuringRefresh, 1); // only the one from import
  assert.equal(refreshed.account.accountId, "acct-uuid-1"); // carried forward
});

test("claude-code refresh classifies invalid_grant/401 as permanent, everything else as transient", async () => {
  // Import validates via /v1/models (this credential has no user:profile
  // scope - see the "user:profile" strip below); refresh() then hits the
  // token endpoint, which is where each test simulates its failure.
  const importFetch = () => modelsResponse();

  const permanent = createClaudeCodeAuth(((url: string) =>
    url === CLAUDE_OAUTH_TOKEN_URL
      ? jsonRes(400, { error: "invalid_grant" })
      : importFetch()) as unknown as typeof fetch);
  const permanentCred = await permanent.import!({
    kind: "auth_json",
    value: FULL_OAUTH_JSON.replace(/"user:profile",?/, ""), // skip profile fetch on import
  });
  await assert.rejects(
    () => permanent.refresh(permanentCred),
    /Claude Code refresh token is no longer valid/,
  );

  const transient = createClaudeCodeAuth(((url: string) =>
    url === CLAUDE_OAUTH_TOKEN_URL
      ? jsonRes(503, { error: "server_error" })
      : importFetch()) as unknown as typeof fetch);
  const transientCred = await transient.import!({
    kind: "auth_json",
    value: FULL_OAUTH_JSON.replace(/"user:profile",?/, ""),
  });
  try {
    await transient.refresh(transientCred);
    assert.fail("should reject");
  } catch (error) {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).name, "Error"); // NOT ProviderReauthRequiredError
    assertNoSecrets(error, "sk-ant-ort01-refresh-value");
  }
});

test("claude-code refresh rejects with no secrets leaked on failure", async () => {
  const { fetchImpl: importFetch } = fakeFetchAlwaysOk();
  const claudeCode = createClaudeCodeAuth(((url: string, init: RequestInit) =>
    url === CLAUDE_OAUTH_TOKEN_URL
      ? jsonRes(401, {})
      : importFetch(url, init)) as unknown as typeof fetch);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: FULL_OAUTH_JSON,
  });
  try {
    await claudeCode.refresh(credential);
    assert.fail("should reject");
  } catch (error) {
    assertNoSecrets(
      error,
      "sk-ant-oat01-access-value",
      "sk-ant-ort01-refresh-value",
    );
  }
});

test("claude-code refresh is a no-op for long-lived credentials (both auth kinds)", async () => {
  const claudeCode = createClaudeCodeAuth(fakeFetchAlwaysOk().fetchImpl);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-oat01-bare-token",
  });
  const refreshed = await claudeCode.refresh(credential);
  assert.equal(refreshed, credential);
});

test("claude-code refresh without a refresh token requires reconnection", async () => {
  const claudeCode = createClaudeCodeAuth();
  const noRefresh: ProviderAuthCredential = {
    integrationId: "claude-code",
    secrets: { accessToken: "sk-ant-oat01-oauth-shaped-but-broken" },
    expiresAt: Date.now() + 60_000,
    account: { tokenKind: "oauth", authKind: "oauth_token" },
  };
  await assert.rejects(() => claudeCode.refresh(noRefresh), /re-import/);
});

// --- runtime + test probe ----------------------------------------------------

test("claude-code runtimeCredential is the bare access token", async () => {
  const claudeCode = createClaudeCodeAuth(fakeFetchAlwaysOk().fetchImpl);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-oat01-bare-token",
  });
  assert.equal(
    claudeCode.runtimeCredential(credential),
    credential.secrets.accessToken,
  );
});

test("claude-code test probes the profile endpoint only for profile-scoped credentials", async () => {
  const { fetchImpl, calls } = fakeFetch(() => profileResponse());
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: FULL_OAUTH_JSON,
  });
  calls.length = 0; // reset after import's own profile call
  const probe = await claudeCode.test(credential);
  assert.equal(probe.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_OAUTH_PROFILE_URL);
});

test("claude-code test probes /v1/models (a real check, not a hand-waved 'ok') for inference-only credentials", async () => {
  const { fetchImpl, calls } = fakeFetchAlwaysOk();
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-oat01-bare-token",
  });
  calls.length = 0; // reset after import's own validation call
  const probe = await claudeCode.test(credential);
  assert.equal(probe.ok, true);
  assert.equal(probe.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_MODELS_URL);
});

test("claude-code test surfaces a real failure for a since-revoked inference-only credential", async () => {
  const claudeCode = createClaudeCodeAuth(fakeFetchAlwaysOk().fetchImpl);
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-oat01-bare-token",
  });
  // Swap in a fetch that now rejects, simulating revocation after import.
  const dead = createClaudeCodeAuth(
    fakeFetch(() => jsonRes(401, {})).fetchImpl,
  );
  const probe = await dead.test(credential);
  assert.equal(probe.ok, false);
  assert.equal(probe.status, 401);
});

test("claude-code begin/poll are rejected (import-only integration)", async () => {
  const claudeCode = createClaudeCodeAuth();
  await assert.rejects(() => claudeCode.begin(), /device authentication/);
  await assert.rejects(() => claudeCode.poll(null), /device authentication/);
});
