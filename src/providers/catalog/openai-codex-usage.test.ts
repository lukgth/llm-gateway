// OpenAI Codex key usage: GET /backend-api/wham/usage.
//
// Success envelope (from the ChatGPT wham API):
//   { rate_limit: { primary_window: { used_percent, reset_at, reset_after_seconds },
//                    secondary_window: { used_percent, reset_at, reset_after_seconds } } }
// Failure: various error JSON shapes or non-2xx status.
//
// `used_percent` (0-100) maps to a percent window: used=percent, limit=100,
// unit="percent", resetsAt=ISO timestamp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiCodex } from "./openai-codex";
import {
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexUserAgent,
} from "../codex";
import type {
  AdapterHttpResponse,
  UsageCtx,
} from "../base";
import { WireKind } from "../../types";

const PROVIDER = {
  id: "openai-codex-provider",
  name: "OpenAI Codex",
  baseUrl: "https://chatgpt.com",
  basePath: "/backend-api/codex",
  modelsPath: "/models",
  endpoints: [WireKind.Responses, WireKind.Chat] as WireKind[],
  authScheme: "bearer" as const,
  format: null,
  host: "chatgpt.com",
  tlsVerify: true,
  extraHeaders: {},
  proxy: null,
  enabled: true,
  catalogId: "openai-codex",
};

// Builds a UsageCtx whose transport returns `resp` and records the
// URL, headers, method, and signal for inspection.
function usageCtx(
  resp: Partial<AdapterHttpResponse>,
  over: Partial<UsageCtx> = {},
  seen?: {
    url?: string;
    headers?: Record<string, string>;
    method?: string;
    signal?: AbortSignal;
  },
): UsageCtx {
  const base = (over.provider ?? PROVIDER) as never;
  return {
    provider: base,
    keyMetadata: { accountId: "acct-123" },
    apiKey: "codex-access-token",
    mask: "codex…ken",
    enabled: true,
    seed: 1,
    baseUrl: "https://chatgpt.com",
    basePath: "/backend-api/codex",
    resolve: (t) =>
      "https://chatgpt.com/backend-api/codex" +
      (typeof t === "string" ? t : ""),
    request: async (
      url: string,
      init: {
        method?: "GET" | "POST";
        headers: Record<string, string>;
        signal?: AbortSignal;
      },
    ) => {
      if (seen) {
        seen.url = url;
        seen.headers = init.headers;
        seen.method = init.method;
        seen.signal = init.signal;
      }
      return {
        status: 200,
        ok: true,
        ms: 1,
        text: "",
        json: () => ({}),
        ...resp,
      } as AdapterHttpResponse;
    },
    ...over,
  } as UsageCtx;
}

// A successful usage response with both windows.
const okUsage = () => ({
  json: () => ({
    rate_limit: {
      primary_window: {
        used_percent: 12,
        reset_at: 1_756_000_000, // fixed Unix timestamp (seconds)
      },
      secondary_window: {
        used_percent: 34,
        reset_at: 1_756_000_000,
      },
    },
  }),
});

test("supportsKeyUsage is true", () => {
  assert.equal(openaiCodex.supportsKeyUsage(usageCtx({})), true);
});

test("a successful response yields two percent windows", async () => {
  const result = await openaiCodex.keyUsage(usageCtx(okUsage()));
  assert.equal(result.unavailable, undefined);
  assert.equal(result.windows.length, 2);

  const session = result.windows[0];
  assert.equal(session.id, "session");
  assert.equal(session.label, "Session");
  assert.equal(session.used, 12);
  assert.equal(session.limit, 100);
  assert.equal(session.unit, "percent");
  assert.equal(session.resetsAt, new Date(1_756_000_000 * 1000).toISOString());

  const weekly = result.windows[1];
  assert.equal(weekly.id, "weekly");
  assert.equal(weekly.label, "Weekly");
  assert.equal(weekly.used, 34);
  assert.equal(weekly.limit, 100);
  assert.equal(weekly.unit, "percent");
  assert.equal(weekly.resetsAt, new Date(1_756_000_000 * 1000).toISOString());
});

test("the request hits /backend-api/wham/usage with Codex identity headers", async () => {
  const seen: {
    url?: string;
    headers?: Record<string, string>;
    method?: string;
    signal?: AbortSignal;
  } = {};
  const signal = new AbortController().signal;
  await openaiCodex.keyUsage(usageCtx(okUsage(), { signal }, seen));
  // The sibling endpoint — NOT under /backend-api/codex.
  assert.equal(seen.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(seen.method, "GET");
  // Codex identity headers.
  assert.equal(seen.headers!["originator"], CODEX_ORIGINATOR);
  assert.equal(seen.headers!["version"], CODEX_CLIENT_VERSION);
  assert.equal(seen.headers!["user-agent"], codexUserAgent());
  assert.equal(seen.headers!["authorization"], "Bearer codex-access-token");
  assert.equal(seen.headers!["chatgpt-account-id"], "acct-123");
  assert.equal(seen.headers!["accept"], "application/json");
  // The signal is forwarded.
  assert.equal(seen.signal, signal);
  // No codex path prefix in the URL.
  assert.equal(seen.url!.includes("/backend-api/codex/backend-api/wham"), false);
});

test("a disabled key returns unavailable without making a request", async () => {
  let called = false;
  const result = await openaiCodex.keyUsage(
    usageCtx(
      {},
      {
        enabled: false,
        request: async () => {
          called = true;
          return { status: 200, ok: true, ms: 0, text: "", json: () => ({}) };
        },
      },
    ),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Key disabled - usage not queried.");
  assert.equal(called, false);
});

test("a trailing slash on baseUrl is normalized for the sibling endpoint", async () => {
  const seen: { url?: string } = {};
  await openaiCodex.keyUsage(
    usageCtx(okUsage(), { baseUrl: "https://chatgpt.com/" }, seen),
  );
  assert.equal(seen.url, "https://chatgpt.com/backend-api/wham/usage");
});

test("reset_after_seconds is accepted when reset_at is absent", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      json: () => ({
        rate_limit: {
          primary_window: {
            used_percent: 50,
            reset_after_seconds: 3600,
          },
        },
      }),
    }),
  );
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].id, "session");
  assert.equal(result.windows[0].used, 50);
  // Should be a future ISO timestamp (allow a small tolerance).
  const ts = new Date(result.windows[0].resetsAt!).getTime();
  const now = Date.now();
  assert.ok(ts > now, `reset timestamp ${ts} should be > now ${now}`);
  assert.ok(
    ts <= now + 3600 * 1000 + 1000,
    `reset timestamp ${ts} should be within 1h+1s of now ${now}`,
  );
});

test("invalid reset values omit resetsAt", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      json: () => ({
        rate_limit: {
          primary_window: {
            used_percent: 50,
            reset_at: 0, // non-positive number
          },
        },
      }),
    }),
  );
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].id, "session");
  assert.equal(result.windows[0].resetsAt, undefined);
});

test("non-2xx JSON errors surface the upstream message", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      status: 401,
      ok: false,
      json: () => ({ error: { message: "invalid token" } }),
    }),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "invalid token");
});

test("non-2xx without a message reports the HTTP status", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      status: 500,
      ok: false,
      json: () => ({ error: { code: "internal" } }),
    }),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Usage endpoint returned HTTP 500");
});

test("transport rejection is caught and reported", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx(
      {},
      {
        request: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    ),
  );
  assert.equal(result.unavailable, true);
  assert.ok(result.message!.includes("ECONNREFUSED"));
});

test("non-JSON response returns unavailable", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      status: 200,
      ok: true,
      text: "<html>not json</html>",
      json: () => {
        throw new Error("not JSON");
      },
    }),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Usage endpoint returned non-JSON response.");
});

test("missing rate_limit returns parse-failure result", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      json: () => ({ something_else: true }),
    }),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Could not parse Codex quota data.");
});

test("missing windows with only one valid window still succeeds", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      json: () => ({
        rate_limit: {
          primary_window: {
            used_percent: 99,
            reset_at: 1_756_000_000,
          },
          // secondary_window absent entirely
        },
      }),
    }),
  );
  assert.equal(result.unavailable, undefined);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].id, "session");
  assert.equal(result.windows[0].used, 99);
});

test("entirely unusable windows returns parse failure", async () => {
  const result = await openaiCodex.keyUsage(
    usageCtx({
      json: () => ({
        rate_limit: {
          primary_window: { used_percent: null },
          secondary_window: { used_percent: "non-numeric" },
        },
      }),
    }),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Could not parse Codex quota data.");
});

test("conflicting case variants of owned headers are replaced by canonical values", async () => {
  // The adapter starts with an empty headers map and calls stripConflicting,
  // so we need to verify that the OUTGOING headers don't contain any of the
  // owned names in any case — the adapter never mixes client-supplied headers
  // into the usage request, so the test is that the canonical values are set.
  const seen: { headers?: Record<string, string> } = {};
  await openaiCodex.keyUsage(usageCtx(okUsage(), {}, seen));
  // The canonical values are lowercase.
  assert.equal(seen.headers!["originator"], CODEX_ORIGINATOR);
  assert.equal(seen.headers!["version"], CODEX_CLIENT_VERSION);
  assert.equal(seen.headers!["user-agent"], codexUserAgent());
  assert.equal(seen.headers!["authorization"], "Bearer codex-access-token");
  assert.equal(seen.headers!["accept"], "application/json");
  // No unwanted uppercase variants.
  assert.equal(
    Object.keys(seen.headers!).filter((k) => k === "Authorization").length,
    0,
  );
  assert.equal(
    Object.keys(seen.headers!).filter((k) => k === "Originator").length,
    0,
  );
  assert.equal(
    Object.keys(seen.headers!).filter((k) => k === "VERSION").length,
    0,
  );
  assert.equal(
    Object.keys(seen.headers!).filter((k) => k === "USER-AGENT").length,
    0,
  );
  assert.equal(
    Object.keys(seen.headers!).filter((k) => k === "ChatGPT-Account-Id").length,
    0,
  );
});

test("missing account metadata omits chatgpt-account-id", async () => {
  const seen: { headers?: Record<string, string> } = {};
  await openaiCodex.keyUsage(
    usageCtx(okUsage(), { keyMetadata: {} }, seen),
  );
  assert.equal(seen.headers!["chatgpt-account-id"], undefined);
});