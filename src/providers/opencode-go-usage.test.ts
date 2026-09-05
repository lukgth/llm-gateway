// OpenCode Go key usage: GET {origin}/v1/usage.
//
// Success envelope:
//   { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
// Failure: { type: "error", error: { type, message } } — served with a 401.
//
// `percent` (0-100) maps directly to a window: used=percent, limit=100,
// unit="percent", resetsAt=resetsAt (an ISO timestamp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "./index";
import type { UsageCtx, AdapterHttpResponse } from "./base";
import type { Provider } from "../types";

const adapter = () => getAdapter("opencode-go")!;

const provider = {
  id: "o",
  name: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go",
  basePath: "",
  catalogId: "opencode-go",
} as Provider;

// Builds a UsageCtx whose transport returns `resp` and records the URL called.
function usageCtx(
  resp: Partial<AdapterHttpResponse>,
  over: Partial<UsageCtx> = {},
  seen?: { url?: string; auth?: string },
): UsageCtx {
  const base = (over.provider ?? provider) as Provider;
  return {
    provider: base,
    keyMetadata: {},
    apiKey: "sk-test",
    mask: "sk-t…st",
    enabled: true,
    seed: 1,
    baseUrl: base.baseUrl,
    basePath: base.basePath ?? "",
    resolve: (t) =>
      base.baseUrl + (base.basePath ?? "") + (typeof t === "string" ? t : ""),
    request: async (
      url: string,
      init: { headers?: Record<string, string> },
    ) => {
      if (seen) {
        seen.url = url;
        seen.auth = init.headers?.authorization;
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

const ok = () => ({
  json: () => ({
    usage: {
      rolling: {
        status: "ok",
        percent: 12,
        resetsAt: "2026-08-12T23:44:35.451Z",
      },
      weekly: {
        status: "ok",
        percent: 0,
        resetsAt: "2026-08-17T00:00:00.451Z",
      },
      monthly: {
        status: "ok",
        percent: 4,
        resetsAt: "2026-09-01T09:09:19.451Z",
      },
    },
  }),
});

test("supportsKeyUsage is true", () => {
  assert.equal(adapter().supportsKeyUsage(usageCtx({})), true);
});

test("a successful response yields three windows", async () => {
  const r = await adapter().keyUsage(usageCtx(ok()));
  assert.equal(r.unavailable, undefined);
  assert.deepEqual(r.windows, [
    {
      id: "rolling-5h",
      label: "Prompts (5h)",
      used: 12,
      limit: 100,
      unit: "percent",
      resetsAt: "2026-08-12T23:44:35.451Z",
    },
    {
      id: "weekly",
      label: "Prompts (weekly)",
      used: 0,
      limit: 100,
      unit: "percent",
      resetsAt: "2026-08-17T00:00:00.451Z",
    },
    {
      id: "monthly",
      label: "Prompts (monthly)",
      used: 4,
      limit: 100,
      unit: "percent",
      resetsAt: "2026-09-01T09:09:19.451Z",
    },
  ]);
});

test("the request hits /v1/usage with bearer auth", async () => {
  const seen: { url?: string; auth?: string } = {};
  await adapter().keyUsage(usageCtx(ok(), {}, seen));
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(seen.auth, "Bearer sk-test");
});

test("the URL follows the configured base URL, not a hardcoded host", async () => {
  // The base URL is an editable field, so the query must go to whatever origin
  // is configured rather than a pinned host.
  const edited = { ...provider, baseUrl: "https://opencode.example.com/zen" };
  const seen: { url?: string } = {};
  await adapter().keyUsage(usageCtx(ok(), { provider: edited as Provider }, seen));
  assert.equal(seen.url, "https://opencode.example.com/zen/v1/usage");
});

test("a non-ok or missing window is omitted", async () => {
  const r = await adapter().keyUsage(
    usageCtx({
      json: () => ({
        usage: {
          rolling: { status: "error", percent: 90, resetsAt: "2026-08-12T00:00:00.000Z" },
          monthly: { status: "ok", percent: 4, resetsAt: "2026-09-01T09:09:19.451Z" },
        },
      }),
    }),
  );
  // rolling is status "error", weekly is missing entirely — both dropped.
  assert.deepEqual(r.windows, [
    {
      id: "monthly",
      label: "Prompts (monthly)",
      used: 4,
      limit: 100,
      unit: "percent",
      resetsAt: "2026-09-01T09:09:19.451Z",
    },
  ]);
});

test("a 401 surfaces the upstream's own message, not a bare status", async () => {
  const r = await adapter().keyUsage(
    usageCtx({
      ok: false,
      status: 401,
      json: () => ({
        type: "error",
        error: { type: "AuthError", message: "Unauthorized" },
      }),
    }),
  );
  assert.equal(r.unavailable, true);
  assert.equal(r.message, "Usage endpoint: Unauthorized (HTTP 401)");
});

test("a disabled key is reported without querying the upstream", async () => {
  let called = false;
  const r = await adapter().keyUsage(
    usageCtx(
      {},
      {
        enabled: false,
        request: async () => {
          called = true;
          throw new Error("should not be called");
        },
      },
    ),
  );
  assert.equal(called, false);
  assert.equal(r.unavailable, true);
  assert.match(r.message ?? "", /disabled/i);
});

test("transport and parse failures degrade to unavailable, never throw", async () => {
  const transport = await adapter().keyUsage(
    usageCtx(
      {},
      {
        request: async () => {
          throw new Error("ECONNRESET");
        },
      },
    ),
  );
  assert.equal(transport.unavailable, true);
  assert.match(transport.message ?? "", /ECONNRESET/);

  const badJson = await adapter().keyUsage(
    usageCtx({
      json: () => {
        throw new Error("bad json");
      },
    }),
  );
  assert.equal(badJson.unavailable, true);
  assert.match(badJson.message ?? "", /non-JSON/);

  const allInvalid = await adapter().keyUsage(
    usageCtx({
      json: () => ({
        usage: {
          rolling: { status: "error" },
          weekly: { status: "ok", percent: "nope", resetsAt: "2026-08-17T00:00:00.000Z" },
        },
      }),
    }),
  );
  assert.equal(allInvalid.unavailable, true);
  assert.match(allInvalid.message ?? "", /parse/i);
});