// Codex managed-auth integration tests: auth.json import, refresh, and test
// probe only. Session-cookie and browser-sign-in paths were removed - the
// Codex backend rejects web-session tokens for completions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexAuth } from "./codex";
import type { ProviderAuthCredential } from "../types";

// --- JWT fixture helpers -----------------------------------------------------

function b64url(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function makeJwt(claims: Record<string, unknown>): string {
  return `header.${b64url(claims)}.signature`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3_600;
const ACCESS_SECRET = "access-token-secret-value";
const REFRESH_SECRET = "refresh-token-secret-value";
const ID_TOKEN = makeJwt({
  email: "user@example.com",
  name: "Test User",
  exp: FUTURE_EXP,
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-id-token" },
});

function accessClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "access@example.com",
    exp: FUTURE_EXP,
    ...extra,
  };
}

const AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: makeJwt(
      accessClaims({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-auth" },
      }),
    ),
    refresh_token: REFRESH_SECRET,
    id_token: ID_TOKEN,
  },
  last_refresh: "2026-01-01T00:00:00Z",
});

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

// --- auth.json import --------------------------------------------------------

test("codex import parses nested auth.json and resolves claims in order", async () => {
  const codex = createCodexAuth();
  const credential = await codex.import!({ kind: "auth_json", value: AUTH_JSON });
  assert.equal(credential.integrationId, "codex");
  assert.equal(credential.account.accountId, "acct-id-token"); // id_token wins
  assert.equal(credential.account.email, "user@example.com");
  assert.equal(credential.secrets.refreshToken, REFRESH_SECRET);
  assert.equal(credential.expiresAt > Date.now(), true);
});

test("codex import accepts direct snake and camel aliases", async () => {
  const codex = createCodexAuth();
  const snake = await codex.import!({
    kind: "auth_json",
    value: JSON.stringify({
      access_token: makeJwt(accessClaims({ chatgpt_account_id: "acct-top" })),
      refresh_token: "r",
    }),
  });
  assert.equal(snake.account.accountId, "acct-top");
  const camel = await codex.import!({
    kind: "auth_json",
    value: JSON.stringify({
      accessToken: makeJwt(
        accessClaims({
          organizations: [{ id: "org-1" }],
        }),
      ),
      accountId: "explicit-acct",
    }),
  });
  assert.equal(camel.account.accountId, "explicit-acct");
});

test("codex import accepts a pasted ChatGPT /api/auth/session payload", async () => {
  const codex = createCodexAuth();
  const sessionJson = JSON.stringify({
    user: { email: "session@example.com", name: "Session User" },
    expires: new Date(Date.now() + 60_000).toISOString(),
    account: { id: "acct-session-json", planType: "plus" },
    accessToken: makeJwt(accessClaims()),
    sessionToken: "jwe-thing-not-needed",
  });
  const credential = await codex.import!({
    kind: "auth_json",
    value: sessionJson,
  });
  assert.equal(credential.account.accountId, "acct-session-json");
  // JWT claims take precedence over the session JSON's user.email.
  assert.equal(credential.account.email, "access@example.com");
  assert.equal(credential.secrets.refreshToken, undefined);
  assert.equal(JSON.stringify(credential).includes("jwe-thing"), false);
});

test("codex import rejects malformed, tokenless, expired, and identity-less input", async () => {
  const codex = createCodexAuth();
  const pastExp = Math.floor(Date.now() / 1000) - 100;
  const cases: Array<[string, string]> = [
    ["not json", "{oops"],
    ["array body", "[]"],
    ["tokenless", JSON.stringify({ tokens: {} })],
    [
      "non-JWT access token",
      JSON.stringify({ access_token: "opaque-not-a-jwt" }),
    ],
    [
      "expired",
      JSON.stringify({
        access_token: makeJwt(accessClaims({ exp: pastExp })),
      }),
    ],
    [
      "missing account id",
      JSON.stringify({ access_token: makeJwt(accessClaims()) }),
    ],
    [
      "missing expiry",
      JSON.stringify({
        access_token: `h.${b64url({ email: "x" })}.s`,
      }),
    ],
  ];
  for (const [label, value] of cases) {
    await assert.rejects(
      () => codex.import!({ kind: "auth_json", value }),
      Error,
      label,
    );
  }
  try {
    await codex.import!({ kind: "auth_json", value: AUTH_JSON.replace("}", "{") });
  } catch (error) {
    assertNoSecrets(error, ACCESS_SECRET, REFRESH_SECRET);
  }
});

// --- refresh -----------------------------------------------------------------

test("codex refresh posts the exact OAuth body and preserves unrotated tokens", async () => {
  const { fetchImpl, calls } = fakeFetch((_url, init) => {
    return jsonRes(200, {
      access_token: makeJwt(
        accessClaims({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-refresh" },
        }),
      ),
    });
  });
  const codex = createCodexAuth(fetchImpl);

  const original: ProviderAuthCredential = await codex.import!({
    kind: "auth_json",
    value: AUTH_JSON,
  });
  const refreshed = await codex.refresh(original);

  assert.equal(calls[0].url, "https://auth.openai.com/oauth/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    (calls[0].init.headers as Record<string, string>)["content-type"],
    "application/json",
  );
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.deepEqual(body, {
    grant_type: "refresh_token",
    refresh_token: REFRESH_SECRET,
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
  });
  assert.equal(refreshed.secrets.refreshToken, REFRESH_SECRET); // preserved
  assert.equal(refreshed.secrets.idToken, ID_TOKEN); // retained
  assert.equal(refreshed.account.accountId, "acct-refresh");
});

test("codex refresh failure maps to a reconnection error without secrets", async () => {
  const { fetchImpl } = fakeFetch(() => jsonRes(400, { error: "invalid_grant" }));
  const codex = createCodexAuth(fetchImpl);
  const original: ProviderAuthCredential = await codex.import!({
    kind: "auth_json",
    value: AUTH_JSON,
  });
  try {
    await codex.refresh(original);
    assert.fail("should reject");
  } catch (error) {
    assertNoSecrets(error, REFRESH_SECRET, ACCESS_SECRET);
  }
  const noRefresh: ProviderAuthCredential = {
    ...original,
    secrets: { accessToken: original.secrets.accessToken },
  };
  await assert.rejects(() => codex.refresh(noRefresh), /re-import/);
});

// --- runtime + test probe ----------------------------------------------------

test("codex runtimeCredential is the bare access token", async () => {
  const codex = createCodexAuth();
  const credential = await codex.import!({ kind: "auth_json", value: AUTH_JSON });
  assert.equal(codex.runtimeCredential(credential), credential.secrets.accessToken);
});

test("codex test probes models with Codex identity headers and filters public entries", async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonRes(200, {
      models: [
        { slug: "gpt-5-codex", display_name: "GPT-5 Codex", visibility: "list", supported_in_api: true },
        { slug: "hidden-model", display_name: "Hidden", visibility: "hide" },
        { slug: "api-off", display_name: "Off", supported_in_api: false },
        { slug: "plain", display_name: "Plain" },
        { slug: "", display_name: "No slug" },
        "garbage",
      ],
    }),
  );
  const codex = createCodexAuth(fetchImpl);
  const credential = await codex.import!({ kind: "auth_json", value: AUTH_JSON });
  const probe = await codex.test(credential);
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.models.map((m) => m.id), ["gpt-5-codex", "plain"]);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers.version, "0.149.0");
  assert.match(headers["user-agent"], /^codex_cli_rs\/0\.149\.0 \(.+\) reqwest\//);
  assert.equal(headers.authorization, `Bearer ${credential.secrets.accessToken}`);
  assert.equal(headers["chatgpt-account-id"], credential.account.accountId);
  assert.match(calls[0].url, /client_version=0\.149\.0$/);
});

test("codex test fails closed on network errors, non-2xx, malformed, and empty model lists", async () => {
  const networkFail = createCodexAuth(
    fakeFetch(() => {
      throw new TypeError("connection refused");
    }).fetchImpl,
  );
  const httpFail = createCodexAuth(fakeFetch(() => jsonRes(500, {})).fetchImpl);
  const malformed = createCodexAuth(
    fakeFetch(() => jsonRes(200, { models: "nope" })).fetchImpl,
  );
  const empty = createCodexAuth(fakeFetch(() => jsonRes(200, { models: [] })).fetchImpl);
  const codexRef = createCodexAuth();
  const credential = await codexRef.import!({ kind: "auth_json", value: AUTH_JSON });

  for (const integration of [networkFail, httpFail, malformed, empty]) {
    const probe = await integration.test(credential);
    assert.equal(probe.ok, false);
    assert.ok(probe.error);
    assert.equal(Array.isArray(probe.models), true);
    assert.equal(JSON.stringify(probe).includes(ACCESS_SECRET), false);
  }
});

// --- device flow rejection ---------------------------------------------------

test("codex begin/poll are rejected (import-only integration)", async () => {
  const codex = createCodexAuth();
  await assert.rejects(() => codex.begin(), /device authentication/);
  await assert.rejects(() => codex.poll(null), /device authentication/);
});