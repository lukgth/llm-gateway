// Claude Code managed-auth integration tests: credential-shape detection on
// import (OAuth JSON, wrapped claudeAiOauth, bare long-lived token, bare
// plain API key), refresh classification, and the test probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaudeCodeAuth } from "./claude-code";
import { NEVER_EXPIRES, type ProviderAuthCredential } from "../types";
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
} from "../../../providers/claude-code-oauth";

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
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

test("claude-code import skips the profile call when scopes lack user:profile", async () => {
  const { fetchImpl, calls } = fakeFetch(() => profileResponse());
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const withoutProfile = JSON.parse(FULL_OAUTH_JSON);
  withoutProfile.claudeAiOauth.scopes = ["user:inference"];
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: JSON.stringify(withoutProfile),
  });
  assert.equal(calls.length, 0);
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

test("claude-code import treats a bare sk-ant-oat01- token as long-lived OAuth", async () => {
  const claudeCode = createClaudeCodeAuth();
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-oat01-bare-long-lived-token",
  });
  assert.equal(credential.secrets.accessToken, "sk-ant-oat01-bare-long-lived-token");
  assert.equal(credential.secrets.refreshToken, undefined);
  assert.equal(credential.account.tokenKind, "long_lived");
  assert.equal(credential.account.authKind, "oauth_token");
  assert.deepEqual(credential.account.scopes, ["user:inference"]);
  assert.equal(credential.expiresAt, NEVER_EXPIRES);
});

test("claude-code import treats a bare sk-ant-api03- key as a plain API key", async () => {
  const claudeCode = createClaudeCodeAuth();
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-api03-plain-console-key",
  });
  assert.equal(credential.account.tokenKind, "long_lived");
  assert.equal(credential.account.authKind, "api_key");
  assert.equal(credential.account.scopes, undefined);
  assert.equal(credential.expiresAt, NEVER_EXPIRES);
});

test("claude-code import rejects an empty paste", async () => {
  const claudeCode = createClaudeCodeAuth();
  await assert.rejects(() => claudeCode.import!({ kind: "auth_json", value: "   " }));
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
  const original = await claudeCode.import!({ kind: "auth_json", value: FULL_OAUTH_JSON });
  const refreshed = await claudeCode.refresh(original);

  const tokenCall = calls.find((c) => c.url === CLAUDE_OAUTH_TOKEN_URL)!;
  const body = JSON.parse(String(tokenCall.init.body)) as Record<string, unknown>;
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
  const permanent = createClaudeCodeAuth(
    fakeFetch(() => jsonRes(400, { error: "invalid_grant" })).fetchImpl,
  );
  const permanentCred = await permanent.import!({
    kind: "auth_json",
    value: FULL_OAUTH_JSON.replace(/"user:profile",?/, ""), // skip profile fetch on import
  });
  await assert.rejects(
    () => permanent.refresh(permanentCred),
    /Claude Code refresh token is no longer valid/,
  );

  const transient = createClaudeCodeAuth(
    fakeFetch(() => jsonRes(503, { error: "server_error" })).fetchImpl,
  );
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
  const { fetchImpl } = fakeFetch(() => jsonRes(401, {}));
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const credential = await claudeCode.import!({ kind: "auth_json", value: FULL_OAUTH_JSON });
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
  const claudeCode = createClaudeCodeAuth();
  for (const secret of ["sk-ant-oat01-bare-token", "sk-ant-api03-plain-key"]) {
    const credential = await claudeCode.import!({ kind: "auth_json", value: secret });
    const refreshed = await claudeCode.refresh(credential);
    assert.equal(refreshed, credential);
  }
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
  const claudeCode = createClaudeCodeAuth();
  const credential = await claudeCode.import!({
    kind: "auth_json",
    value: "sk-ant-api03-plain-console-key",
  });
  assert.equal(claudeCode.runtimeCredential(credential), credential.secrets.accessToken);
});

test("claude-code test probes the profile endpoint only for profile-scoped credentials", async () => {
  const { fetchImpl, calls } = fakeFetch(() => profileResponse());
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  const credential = await claudeCode.import!({ kind: "auth_json", value: FULL_OAUTH_JSON });
  calls.length = 0; // reset after import's own profile call
  const probe = await claudeCode.test(credential);
  assert.equal(probe.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_OAUTH_PROFILE_URL);
});

test("claude-code test reports 'imported' without probing for inference-only/plain-key credentials", async () => {
  const { fetchImpl, calls } = fakeFetch(() => profileResponse());
  const claudeCode = createClaudeCodeAuth(fetchImpl);
  for (const secret of ["sk-ant-oat01-bare-token", "sk-ant-api03-plain-key"]) {
    const credential = await claudeCode.import!({ kind: "auth_json", value: secret });
    const probe = await claudeCode.test(credential);
    assert.equal(probe.ok, true);
    assert.equal(probe.status, null);
    assert.match(probe.error ?? "", /no cheap probe endpoint/);
  }
  assert.equal(calls.length, 0);
});

test("claude-code begin/poll are rejected (import-only integration)", async () => {
  const claudeCode = createClaudeCodeAuth();
  await assert.rejects(() => claudeCode.begin(), /device authentication/);
  await assert.rejects(() => claudeCode.poll(null), /device authentication/);
});
