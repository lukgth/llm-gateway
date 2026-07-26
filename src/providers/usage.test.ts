// Provider usage-reporting tests: the adapter's default keyUsage() returns
// deterministic placeholder windows (5h + weekly), so the dashboard renders
// stable bars and never leaks a raw key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dummyUsageWindows } from "./base";
import { adapterForProvider } from ".";
import type { Provider } from "../types";
import type { UsageCtx, AdapterHttpResponse } from "./base";
import { newapi } from "./catalog/newapi";
import { openrouter } from "./catalog/openrouter";
import { glm } from "./catalog/glm";
import { claudeCode } from "./catalog/claude-code";

// Fills in the request/resolve primitives every UsageCtx needs (a test that
// only exercises the default keyUsage()/supportsKeyUsage() never calls them).
function usageCtx(
  p: Provider,
  fields: Pick<UsageCtx, "apiKey" | "mask" | "enabled" | "seed">,
): UsageCtx {
  return {
    provider: p,
    keyMetadata: {},
    baseUrl: p.baseUrl,
    basePath: p.basePath || "",
    resolve: (target) => p.baseUrl + (typeof target === "string" ? target : ""),
    request: () => {
      throw new Error("not implemented in test");
    },
    ...fields,
  };
}

function prov(over: Partial<Provider>): Provider {
  return {
    id: "p",
    name: "p",
    baseUrl: "https://api.example.com",
    host: null,
    keyCount: { enabled: 0, disabled: 0, total: 0 },
    authScheme: "bearer",
    extraHeaders: {},
    retryAttempts: 1,
    retryIntervalMs: 0,
    requestTimeoutMs: 1000,
    tlsVerify: true,
    enabled: true,
    format: "openai",
    endpoints: [],
    endpointPaths: {},
    nativeConversion: false,
    catalogId: null,
    basePath: "",
    modelsPath: "/v1/models",
    proxy: null,
    country: null,
    providerConfig: {},
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

// resetsAt is relative to Date.now(), so compare only the deterministic fields.
const stable = (w: { id: string; used: number; limit: number }) => ({
  id: w.id,
  used: w.used,
  limit: w.limit,
});

test("dummyUsageWindows is deterministic and covers token + request units", () => {
  const a = dummyUsageWindows(12345);
  const b = dummyUsageWindows(12345);
  assert.deepEqual(a.map(stable), b.map(stable));
  assert.deepEqual(
    a.map((w) => w.id),
    ["5h", "weekly", "daily-requests"],
  );
  // Both a token-limit and a request-limit window are present.
  assert.ok(a.some((w) => w.unit === "tokens"));
  assert.ok(a.some((w) => w.unit === "requests"));
  for (const w of a) {
    assert.ok(w.used >= 0 && w.used <= w.limit, "used within limit");
    assert.ok(w.limit > 0);
    // dummyUsageWindows always sets a rolling resetsAt (5h/weekly/daily are
    // genuine refill windows, unlike a one-shot credit grant).
    assert.ok(typeof w.resetsAt === "string");
    assert.ok(
      !Number.isNaN(Date.parse(w.resetsAt as string)),
      "resetsAt is a date",
    );
  }
});

test("different seeds produce different usage", () => {
  const a = dummyUsageWindows(1);
  const b = dummyUsageWindows(2);
  assert.notDeepEqual(a.map(stable), b.map(stable));
});

test("adapter.supportsKeyUsage default is false (provider hidden from dashboard)", () => {
  // A stock provider with no real usage endpoint opts OUT of the dashboard, so
  // the route omits it rather than rendering a card of empty keys.
  const p = prov({ catalogId: "openai" });
  const adapter = adapterForProvider(p);
  const ctx = usageCtx(p, {
    apiKey: "sk-secret",
    mask: "sk-…abcd",
    enabled: true,
    seed: 42,
  });
  assert.equal(adapter.supportsKeyUsage(ctx), false);
});

test("adapter.keyUsage default is unavailable, not dummy (async)", async () => {
  // A provider with no real usage endpoint reports `unavailable` (dummy is false
  // by default) rather than fabricating estimate bars.
  const p = prov({ catalogId: "openai" });
  const adapter = adapterForProvider(p);
  const res = await adapter.keyUsage(
    usageCtx(p, {
      apiKey: "sk-secret",
      mask: "sk-…abcd",
      enabled: true,
      seed: 42,
    }),
  );
  assert.equal(res.dummy ?? false, false);
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
  assert.ok(typeof res.message === "string" && res.message.length > 0);
});

// --- NewAPI: real GET /api/usage/token keyUsage() --------------------------

function jsonResponse(status: number, body: unknown): AdapterHttpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    ms: 1,
    text,
    json: () => JSON.parse(text),
  };
}

function newapiCtx(
  p: Provider,
  request: UsageCtx["request"],
  fields?: Partial<Pick<UsageCtx, "enabled" | "seed">>,
): UsageCtx {
  return {
    provider: p,
    apiKey: "sk-secret",
    keyMetadata: {},
    mask: "sk-…abcd",
    enabled: true,
    seed: 1,
    baseUrl: p.baseUrl,
    basePath: p.basePath || "",
    resolve: (target) => p.baseUrl + (typeof target === "string" ? target : ""),
    request,
    ...fields,
  };
}

test("newapi.supportsKeyUsage is true (opts into the dashboard)", () => {
  const p = prov({ catalogId: "newapi" });
  assert.equal(
    newapi.supportsKeyUsage(
      newapiCtx(p, async () => {
        throw new Error("unused");
      }),
    ),
    true,
  );
});

test("newapi.keyUsage: disabled key -> unavailable without a network call", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(
      p,
      async () => {
        throw new Error("must not be called");
      },
      { enabled: false },
    ),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
});

test("newapi.keyUsage: GET /api/usage/token with Bearer auth, capped quota", async () => {
  const p = prov({
    catalogId: "newapi",
    baseUrl: "https://api.newapi.example",
  });
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const res = await newapi.keyUsage(
    newapiCtx(p, async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return jsonResponse(200, {
        code: true,
        data: {
          expires_at: 0,
          model_limits: {},
          model_limits_enabled: false,
          name: "testing",
          object: "token_usage",
          total_available: 1000000,
          total_granted: 1002076,
          total_used: 2076,
          unlimited_quota: false,
        },
        message: "ok",
      });
    }),
  );
  assert.equal(seenUrl, "https://api.newapi.example/api/usage/token");
  assert.equal(seenHeaders.authorization, "Bearer sk-secret");
  assert.equal(res.unavailable, undefined);
  assert.equal(res.windows.length, 1);
  const w = res.windows[0];
  // Values are converted from credits to dollars (default rate: 1M credits/$1).
  assert.equal(w.used, 2076 / 1_000_000);
  assert.equal(w.limit, 1002076 / 1_000_000);
  assert.equal(w.unit, "dollars");
  assert.ok(!w.label.includes("unlimited"));
  // A credit grant is a one-shot balance, not a refilling window - no
  // resetsAt on the window at all.
  assert.equal(w.resetsAt, undefined);
  // expires_at: 0 -> the provider reports no expiry -> field omitted.
  assert.equal(res.expiresAt, undefined);
});

test("newapi.keyUsage: expires_at > 0 -> reported as key-level expiresAt, not a window reset", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () =>
      jsonResponse(200, {
        code: true,
        data: {
          expires_at: 1786735990,
          model_limits: {},
          model_limits_enabled: false,
          name: "testing",
          object: "token_usage",
          total_available: 1000000,
          total_granted: 1002076,
          total_used: 2076,
          unlimited_quota: false,
        },
        message: "ok",
      }),
    ),
  );
  assert.equal(res.expiresAt, new Date(1786735990 * 1000).toISOString());
  // The window itself still has no resetsAt - expiry is the KEY's lifetime,
  // not a per-window refill cycle.
  assert.equal(res.windows[0].resetsAt, undefined);
});

test("newapi.keyUsage: unlimited_quota -> finite JSON-safe sentinel limit, labeled unlimited", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () =>
      jsonResponse(200, {
        code: true,
        data: {
          expires_at: 0,
          name: "testing",
          object: "token_usage",
          total_available: 0,
          total_granted: 2076,
          total_used: 2076,
          unlimited_quota: true,
        },
        message: "ok",
      }),
    ),
  );
  const w = res.windows[0];
  assert.equal(w.used, 2076 / 1_000_000);
  // Never Infinity - JSON.stringify(Infinity) => null, which breaks the
  // wire response and the frontend's used/limit math.
  assert.ok(Number.isFinite(w.limit));
  assert.ok(w.limit > w.used);
  assert.ok(w.label.includes("unlimited"));
  assert.equal(JSON.parse(JSON.stringify(res)).windows[0].limit, w.limit);
});

test("newapi.keyUsage: custom quotaPerDollar converts credits to dollars correctly", async () => {
  const p = prov({
    catalogId: "newapi",
    providerConfig: { quotaPerDollar: 2_000_000 },
  });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () =>
      jsonResponse(200, {
        code: true,
        data: {
          total_available: 100,
          total_used: 2_000_000,
          unlimited_quota: false,
        },
      }),
    ),
  );
  const w = res.windows[0];
  assert.equal(w.unit, "dollars");
  // 2_000_000 credits at 2M/$1 = $1.00 used
  assert.equal(w.used, 1);
  assert.equal(w.label, "Balance");
});

test("newapi.keyUsage: default quotaPerDollar (no providerConfig) converts at 1M/$1", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () =>
      jsonResponse(200, {
        code: true,
        data: {
          total_available: 500_000,
          total_used: 500_000,
          unlimited_quota: false,
        },
      }),
    ),
  );
  const w = res.windows[0];
  assert.equal(w.unit, "dollars");
  // 500k credits at 1M/$1 = $0.50 used, $1.00 limit
  assert.equal(w.used, 0.5);
  assert.equal(w.limit, 1);
  assert.equal(w.label, "Balance");
});

test("newapi.keyUsage: non-2xx status -> unavailable with status in message", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () =>
      jsonResponse(401, { code: false, message: "bad key" }),
    ),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /401/);
});

test("newapi.keyUsage: code:false envelope -> unavailable with upstream message", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () =>
      jsonResponse(200, { code: false, message: "token not found" }),
    ),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.message, "token not found");
});

test("newapi.keyUsage: network error -> unavailable, error surfaced in message", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () => {
      throw new Error("ECONNREFUSED");
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /ECONNREFUSED/);
});

test("newapi.keyUsage: malformed JSON -> unavailable, no throw", async () => {
  const p = prov({ catalogId: "newapi" });
  const res = await newapi.keyUsage(
    newapiCtx(p, async () => ({
      status: 200,
      ok: true,
      ms: 1,
      text: "not json",
      json: () => {
        throw new SyntaxError("Unexpected token");
      },
    })),
  );
  assert.equal(res.unavailable, true);
});

// --- OpenRouter: real GET /v1/key keyUsage() --------------------------------

function openrouterCtx(
  p: Provider,
  request: UsageCtx["request"],
  fields?: Partial<Pick<UsageCtx, "enabled" | "seed">>,
): UsageCtx {
  return {
    provider: p,
    apiKey: "sk-or-secret",
    keyMetadata: {},
    mask: "sk-or…cret",
    enabled: true,
    seed: 1,
    baseUrl: p.baseUrl,
    basePath: p.basePath || "",
    resolve: (target) => p.baseUrl + (typeof target === "string" ? target : ""),
    request,
    ...fields,
  };
}

test("openrouter.supportsKeyUsage is true (opts into the dashboard)", () => {
  const p = prov({
    catalogId: "openrouter",
    baseUrl: "https://openrouter.ai/api",
  });
  assert.equal(
    openrouter.supportsKeyUsage(
      openrouterCtx(p, async () => {
        throw new Error("unused");
      }),
    ),
    true,
  );
});

test("openrouter.keyUsage: disabled key -> unavailable without a network call", async () => {
  const p = prov({
    catalogId: "openrouter",
    baseUrl: "https://openrouter.ai/api",
  });
  const res = await openrouter.keyUsage(
    openrouterCtx(
      p,
      async () => {
        throw new Error("must not be called");
      },
      { enabled: false },
    ),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
});

test("openrouter.keyUsage: GET /api/v1/key with Bearer auth, capped monthly usage", async () => {
  const p = prov({
    catalogId: "openrouter",
    baseUrl: "https://openrouter.ai/api",
  });
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return jsonResponse(200, {
        data: {
          limit: 100,
          limit_remaining: 74.5,
          limit_reset: "monthly",
          usage: 250,
          usage_monthly: 999,
          byok_usage_monthly: 50,
          include_byok_in_limit: false,
          is_free_tier: false,
        },
      });
    }),
  );
  assert.equal(seenUrl, "https://openrouter.ai/api/v1/key");
  assert.equal(seenHeaders.authorization, "Bearer sk-or-secret");
  assert.equal(seenHeaders.accept, "application/json");
  assert.equal(res.unavailable, undefined);
  assert.equal(res.windows.length, 1);
  const w = res.windows[0];
  // Remaining credit is authoritative for a resetting key. All-time and period
  // counters above are deliberately different so this catches the wrong source.
  assert.equal(w.used, 25.5);
  assert.equal(w.limit, 100);
  assert.equal(w.unit, "dollars");
  assert.equal(w.label, "Spending limit (monthly)");
  // `limit_reset` is a cadence string, not an absolute ISO timestamp.
  assert.equal(w.resetsAt, undefined);
});

test("openrouter.keyUsage: missing remaining falls back to reset counter and included BYOK usage", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () =>
      jsonResponse(200, {
        data: {
          limit: 50,
          limit_remaining: null,
          limit_reset: "weekly",
          usage: 40,
          usage_weekly: 7.25,
          byok_usage_weekly: 1.75,
          include_byok_in_limit: true,
        },
      }),
    ),
  );
  const w = res.windows[0];
  assert.equal(w.used, 9);
  assert.equal(w.limit, 50);
  assert.equal(w.label, "Spending limit (weekly)");
});

test("openrouter.keyUsage: excluded BYOK usage is not added to fallback usage", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () =>
      jsonResponse(200, {
        data: {
          limit: 20,
          limit_reset: "daily",
          usage_daily: 3,
          byok_usage_daily: 8,
          include_byok_in_limit: false,
        },
      }),
    ),
  );
  assert.equal(res.windows[0].used, 3);
});

test("openrouter.keyUsage: missing included BYOK counter defaults to zero", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () =>
      jsonResponse(200, {
        data: {
          limit: 20,
          limit_reset: "daily",
          usage_daily: 3,
          include_byok_in_limit: true,
        },
      }),
    ),
  );
  assert.equal(res.unavailable, undefined);
  assert.equal(res.windows[0].used, 3);
});

test("openrouter.keyUsage: null limit -> all-time usage message without an invented limit", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () =>
      jsonResponse(200, {
        data: {
          limit: null,
          limit_remaining: null,
          limit_reset: null,
          usage: 39.850865837,
          byok_usage: 12,
          include_byok_in_limit: false,
          is_free_tier: true,
        },
      }),
    ),
  );
  assert.equal(res.unavailable, undefined);
  assert.deepEqual(res.windows, []);
  assert.equal(
    res.message,
    "Free tier · $39.85 used all time · No key spending limit",
  );
});

test("openrouter.keyUsage: reports key expiry and free tier metadata", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () =>
      jsonResponse(200, {
        data: {
          limit: 10,
          limit_remaining: 10,
          usage: 0,
          is_free_tier: true,
          expires_at: "2027-12-31T23:59:59Z",
        },
      }),
    ),
  );
  assert.equal(res.expiresAt, "2027-12-31T23:59:59.000Z");
  assert.equal(res.message, "Free tier");
});

test("openrouter.keyUsage: out-of-range expiry is ignored without throwing", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () =>
      jsonResponse(200, {
        data: {
          limit: 10,
          limit_remaining: 10,
          usage: 0,
          expires_at: "999999999999999999999",
        },
      }),
    ),
  );
  assert.equal(res.unavailable, undefined);
  assert.equal(res.expiresAt, undefined);
});

test("openrouter.keyUsage: non-2xx status -> unavailable with status in message", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () =>
      jsonResponse(401, { error: { message: "bad key" } }),
    ),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /401/);
});

test("openrouter.keyUsage: network error -> unavailable, error surfaced in message", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () => {
      throw new Error("ECONNREFUSED");
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /ECONNREFUSED/);
});

test("openrouter.keyUsage: malformed JSON -> unavailable, no throw", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () => ({
      status: 200,
      ok: true,
      ms: 1,
      text: "not json",
      json: () => {
        throw new SyntaxError("Unexpected token");
      },
    })),
  );
  assert.equal(res.unavailable, true);
});

test("openrouter.keyUsage: missing data envelope -> unavailable", async () => {
  const p = prov({ catalogId: "openrouter" });
  const res = await openrouter.keyUsage(
    openrouterCtx(p, async () => jsonResponse(200, { data: null })),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
  assert.match(res.message ?? "", /unexpected response/i);
});

// --- claude-code passive unified usage --------------------------------------

test("claude-code reports capability but untried key is unavailable", async () => {
  const p = prov({ catalogId: "claude-code" });
  const ctx = usageCtx(p, {
    apiKey: "sk-ant-secret",
    mask: "sk-ant…cret",
    enabled: true,
    seed: 1,
  });
  assert.equal(claudeCode.supportsKeyUsage(ctx), true);
  const result = await claudeCode.keyUsage(ctx);
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.windows, []);
});

test("claude-code maps captured unified snapshot to real windows", async () => {
  const p = prov({ catalogId: "claude-code" });
  const ctx: UsageCtx = {
    ...usageCtx(p, {
      apiKey: "sk-ant-secret",
      mask: "sk-ant…cret",
      enabled: true,
      seed: 1,
    }),
    unifiedUsage: {
      headers: {
        "anthropic-ratelimit-unified-status": "allowed_warning",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "1784607600",
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
      },
      httpStatus: 200,
      capturedAt: "2026-07-21T01:00:00.000Z",
    },
  };
  const result = await claudeCode.keyUsage(ctx);
  assert.equal(result.unavailable, undefined);
  assert.equal(result.dummy, false);
  assert.equal(result.message, "Approaching rate limit");
  assert.deepEqual(
    result.windows.map((window) => [window.id, window.used]),
    [
      ["unified-5h", 25],
      ["unified-7d", 50],
    ],
  );
});

// --- glm-coding (Z.ai) -------------------------------------------------------

function glmCtx(
  p: Provider,
  request: UsageCtx["request"],
  fields?: Partial<Pick<UsageCtx, "enabled" | "seed">>,
): UsageCtx {
  return {
    provider: p,
    apiKey: "sk-secret",
    keyMetadata: {},
    mask: "sk-…abcd",
    enabled: true,
    seed: 1,
    baseUrl: p.baseUrl,
    basePath: p.basePath || "",
    resolve: (target) => p.baseUrl + (typeof target === "string" ? target : ""),
    request,
    ...fields,
  };
}

test("glm.supportsKeyUsage is true (opts into the dashboard)", () => {
  const p = prov({ catalogId: "glm-coding" });
  assert.equal(
    glm.supportsKeyUsage(
      glmCtx(p, async () => {
        throw new Error("unused");
      }),
    ),
    true,
  );
});

test("glm.keyUsage: disabled key -> unavailable without a network call", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(
      p,
      async () => {
        throw new Error("must not be called");
      },
      { enabled: false },
    ),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
});

test("glm.keyUsage: GET /api/monitor/usage/quota/limit (a sibling of basePath, not under it), Bearer auth", async () => {
  const p = prov({
    catalogId: "glm-coding",
    baseUrl: "https://api.z.ai",
    basePath: "/api/coding/paas/v4",
  });
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const res = await glm.keyUsage(
    glmCtx(p, async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return jsonResponse(200, {
        code: 200,
        msg: "Operation successful",
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 0 },
            {
              type: "TIME_LIMIT",
              percentage: 0,
              currentValue: 0,
              usage: 1000,
              usageDetails: [
                { modelCode: "search-prime", usage: 0 },
                { modelCode: "web-reader", usage: 0 },
                { modelCode: "zread", usage: 0 },
              ],
            },
          ],
          level: "lite",
        },
        success: true,
      });
    }),
  );
  // Not "https://api.z.ai/api/coding/paas/v4/api/monitor/…" - this endpoint
  // is NOT under basePath, so it must be built from the bare origin.
  assert.equal(seenUrl, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(seenHeaders.authorization, "Bearer sk-secret");
  assert.equal(res.unavailable, undefined);
});

test("glm.keyUsage: TIME_LIMIT (MCP tool usage) maps to a requests window with used/limit", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          limits: [
            {
              type: "TIME_LIMIT",
              percentage: 37,
              currentValue: 37,
              usage: 100,
              usageDetails: [{ modelCode: "search-prime", usage: 37 }],
            },
          ],
          level: "lite",
        },
        success: true,
      }),
    ),
  );
  // The 5h Prompts window is always shown (defaulted to 0%) even when the
  // response has no TOKENS_LIMIT entries at all; weekly is absent since no
  // weekly entry was returned. Plus the MCP window.
  assert.equal(res.windows.length, 2);
  assert.equal(
    res.windows.some((w) => w.id === "tokens-weekly"),
    false,
  );
  const mcp = res.windows.find((w) => w.id === "mcp-monthly")!;
  assert.equal(mcp.label, "MCP tools (monthly)");
  assert.equal(mcp.used, 37);
  assert.equal(mcp.limit, 100);
  assert.equal(mcp.unit, "requests");
  // TIME_LIMIT is a monthly period, not a countdown - no resetsAt upstream.
  assert.equal(mcp.resetsAt, undefined);
  const fiveHour = res.windows.find((w) => w.id === "tokens-5h")!;
  assert.equal(fiveHour.used, 0);
  assert.equal(fiveHour.limit, 100);
});

test("glm.keyUsage: TOKENS_LIMIT (5h + weekly prompt quota) has no absolute total -> percentage-based bar (used=%, limit=100)", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 40.5,
              nextResetTime: 1785763345975,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 52,
              nextResetTime: 1786195345975,
            },
          ],
          level: "lite",
        },
        success: true,
      }),
    ),
  );
  assert.equal(res.windows.length, 2);
  const fiveHour = res.windows.find((w) => w.id === "tokens-5h")!;
  assert.equal(fiveHour.label, "Prompts (5h)");
  assert.equal(fiveHour.used, 40.5);
  assert.equal(fiveHour.limit, 100);
  assert.equal(fiveHour.unit, "percent");
  assert.equal(fiveHour.resetsAt, new Date(1785763345975).toISOString());
  const weekly = res.windows.find((w) => w.id === "tokens-weekly")!;
  assert.equal(weekly.label, "Prompts (weekly)");
  assert.equal(weekly.used, 52);
  assert.equal(weekly.limit, 100);
  assert.equal(weekly.resetsAt, new Date(1786195345975).toISOString());
  // Message carries ONLY the plan - no percentage notes folded in.
  assert.equal(res.message, "Plan: Lite");
});

test("glm.keyUsage: 5h Prompts window always appears (defaulted to 0%) even when the response has zero limits at all; weekly does not", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(200, {
        code: 200,
        data: { limits: [] },
        success: true,
      }),
    ),
  );
  assert.equal(res.windows.length, 1);
  assert.equal(res.windows[0].id, "tokens-5h");
  assert.equal(res.windows[0].used, 0);
  assert.equal(res.windows[0].limit, 100);
  // No level in this response -> no message at all.
  assert.equal(res.message, undefined);
});

test("glm.keyUsage: weekly Prompts window only appears when the upstream actually returns it", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 18,
              nextResetTime: 1786195345975,
            },
          ],
        },
        success: true,
      }),
    ),
  );
  assert.equal(res.windows.length, 2);
  const fiveHour = res.windows.find((w) => w.id === "tokens-5h")!;
  assert.equal(fiveHour.used, 0); // defaulted - no 5h entry in this response
  const weekly = res.windows.find((w) => w.id === "tokens-weekly")!;
  assert.equal(weekly.label, "Prompts (weekly)");
  assert.equal(weekly.used, 18);
  assert.equal(weekly.limit, 100);
  assert.equal(weekly.resetsAt, new Date(1786195345975).toISOString());
});

test("glm.keyUsage: unrecognized TOKENS_LIMIT unit/number is still surfaced as an extra window, not dropped", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 8, number: 2, percentage: 10 },
          ],
        },
        success: true,
      }),
    ),
  );
  // The guaranteed 5h window (defaulted, no matching entry) plus the
  // unrecognized one - no weekly window since none was returned.
  assert.equal(res.windows.length, 2);
  assert.equal(
    res.windows.some((w) => w.id === "tokens-weekly"),
    false,
  );
  const extra = res.windows.find((w) => w.id === "tokens-8-2")!;
  assert.equal(extra.label, "Prompts (unit=8, number=2)");
  assert.equal(extra.used, 10);
  assert.equal(extra.limit, 100);
});

test("glm.keyUsage: `level` surfaces as the ONLY key message, title-cased", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(200, {
        code: 200,
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 40.5,
            },
            {
              type: "TIME_LIMIT",
              percentage: 0,
              currentValue: 0,
              usage: 100,
            },
          ],
          // Upstream may send any casing ("lite", "PRO", …) - must normalize.
          level: "PRO",
        },
        success: true,
      }),
    ),
  );
  assert.equal(res.message, "Plan: Pro");
});

test("glm.keyUsage: non-2xx status -> unavailable with status in message", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(401, { code: 401, msg: "unauthorized" }),
    ),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /401/);
});

test("glm.keyUsage: success:false envelope -> unavailable with upstream msg", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () =>
      jsonResponse(200, {
        code: 500,
        msg: "internal error",
        success: false,
      }),
    ),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.message, "internal error");
});

test("glm.keyUsage: network error -> unavailable, error surfaced in message", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () => {
      throw new Error("ECONNREFUSED");
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /ECONNREFUSED/);
});

test("glm.keyUsage: malformed JSON -> unavailable, no throw", async () => {
  const p = prov({ catalogId: "glm-coding" });
  const res = await glm.keyUsage(
    glmCtx(p, async () => ({
      status: 200,
      ok: true,
      ms: 1,
      text: "not json",
      json: () => {
        throw new SyntaxError("Unexpected token");
      },
    })),
  );
  assert.equal(res.unavailable, true);
});
