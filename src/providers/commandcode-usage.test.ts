// Command Code key usage: four sequential /alpha/* calls (whoami ->
// subscriptions -> credits -> usage summary) against {origin}/alpha - a
// SIBLING of /provider/v1, built from ctx.baseUrl directly (never through
// basePath).
//
// Window: cycle spend (summary.totalCost) against the cycle's total credits
// (spent + remaining monthly/purchased/free), resets = currentPeriodStart + 1
// calendar month. The plan level rides along as the key message ("Plan: Pro").

import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "./index";
import type { UsageCtx, AdapterHttpResponse } from "./base";
import type { Provider } from "../types";

const adapter = () => getAdapter("commandcode")!;

const provider = {
  id: "commandcode-test",
  name: "Command Code",
  catalogId: "commandcode",
  baseUrl: "https://api.commandcode.ai",
  basePath: "/provider/v1",
} as Provider;

// Builds a UsageCtx whose transport dispatches on the full URL (keyUsage makes
// four dependent calls) and records every call for order/auth assertions.
function usageCtx(
  responses:
    | Record<string, Partial<AdapterHttpResponse>>
    | ((url: string) => Partial<AdapterHttpResponse>),
  over: Partial<UsageCtx> = {},
  seen?: { urls: string[]; auth?: string },
): UsageCtx {
  const base = (over.provider ?? provider) as Provider;
  return {
    provider: base,
    keyMetadata: {},
    apiKey: "cmd-test-key",
    mask: "cmd-…key",
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
        seen.urls.push(url);
        if (init.headers?.authorization) seen.auth = init.headers.authorization;
      }
      const r =
        typeof responses === "function" ? responses(url) : responses[url];
      return {
        status: 200,
        ok: true,
        ms: 1,
        text: "",
        json: () => ({}),
        ...r,
      } as AdapterHttpResponse;
    },
    ...over,
  } as UsageCtx;
}

const json = (body: unknown): Partial<AdapterHttpResponse> => ({
  json: () => body,
});

// Canned happy-path responses, keyed by the exact URLs the adapter builds.
const happy: Record<string, Partial<AdapterHttpResponse>> = {
  "https://api.commandcode.ai/alpha/whoami": json({
    org: { id: "org-123", login: "acme" },
    user: { userName: "acme" },
  }),
  "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-123": json({
    data: {
      currentPeriodStart: "2026-08-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-31T00:00:00.000Z",
      planId: "pro",
    },
  }),
  "https://api.commandcode.ai/alpha/billing/credits?orgId=org-123": json({
    credits: { monthlyCredits: 12.5, purchasedCredits: 40, freeCredits: 0.5 },
  }),
  "https://api.commandcode.ai/alpha/usage/summary?orgId=org-123&since=2026-08-01T00%3A00%3A00.000Z":
    json({ totalCost: 3.25 }),
};

test("supportsKeyUsage is true", () => {
  assert.equal(adapter().supportsKeyUsage(usageCtx({})), true);
});

test("a successful cycle report shows spend vs total credits with a reset", async () => {
  const res = await adapter().keyUsage(usageCtx(happy));
  assert.deepEqual(res, {
    windows: [
      {
        id: "credits-cycle",
        label: "Credits (cycle)",
        used: 3.25,
        limit: 56.25,
        unit: "dollars",
        resetsAt: "2026-08-31T00:00:00.000Z",
      },
    ],
    message: "Plan: Pro",
  });
});

test("the four calls run in order against {origin}/alpha with bearer auth", async () => {
  const seen: { urls: string[]; auth?: string } = { urls: [] };
  await adapter().keyUsage(usageCtx(happy, {}, seen));
  assert.deepEqual(seen.urls, [
    "https://api.commandcode.ai/alpha/whoami",
    "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-123",
    "https://api.commandcode.ai/alpha/billing/credits?orgId=org-123",
    "https://api.commandcode.ai/alpha/usage/summary?orgId=org-123&since=2026-08-01T00%3A00%3A00.000Z",
  ]);
  assert.equal(seen.auth, "Bearer cmd-test-key");
  for (const u of seen.urls) {
    assert.ok(!u.includes("/provider/v1"), `sibling path leaked into ${u}`);
  }
});

test("the URLs follow a configured base URL, not a hardcoded host", async () => {
  const seen = { urls: [] as string[] };
  const over = {
    provider: { ...provider, baseUrl: "https://cc.example" } as Provider,
  };
  await adapter().keyUsage(usageCtx(happy, over, seen));
  assert.equal(seen.urls[0], "https://cc.example/alpha/whoami");
});

test("a disabled key is reported without querying the upstream", async () => {
  const seen = { urls: [] as string[] };
  const res = await adapter().keyUsage(
    usageCtx(happy, { enabled: false }, seen),
  );
  assert.deepEqual(res, {
    windows: [],
    unavailable: true,
    message: "Key disabled - usage not queried.",
  });
  assert.deepEqual(seen.urls, []);
});

test("a whoami 401 surfaces HTTP 401", async () => {
  const res = await adapter().keyUsage(
    usageCtx({
      "https://api.commandcode.ai/alpha/whoami": { status: 401, ok: false },
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /HTTP 401/);
});

test("a personal key (whoami org: null) queries the same endpoints without orgId", async () => {
  // Live shape from a user-scoped Studio key: org: null, plan "individual-goat".
  const responses: Record<string, Partial<AdapterHttpResponse>> = {
    "https://api.commandcode.ai/alpha/whoami": json({
      success: true,
      user: { userName: "xvv7" },
      org: null,
    }),
    "https://api.commandcode.ai/alpha/billing/subscriptions": json({
      data: {
        currentPeriodStart: "2026-08-08T07:45:24.000Z",
        currentPeriodEnd: "2026-09-08T07:45:24.000Z",
        planId: "individual-goat",
      },
    }),
    "https://api.commandcode.ai/alpha/billing/credits": json({
      credits: { monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 },
    }),
    "https://api.commandcode.ai/alpha/usage/summary?since=2026-08-08T07%3A45%3A24.000Z":
      json({ totalCost: 0 }),
  };
  const seen = { urls: [] as string[] };
  const res = await adapter().keyUsage(usageCtx(responses, {}, seen));
  assert.deepEqual(seen.urls, [
    "https://api.commandcode.ai/alpha/whoami",
    "https://api.commandcode.ai/alpha/billing/subscriptions",
    "https://api.commandcode.ai/alpha/billing/credits",
    "https://api.commandcode.ai/alpha/usage/summary?since=2026-08-08T07%3A45%3A24.000Z",
  ]);
  for (const u of seen.urls) {
    assert.ok(!u.includes("orgId="), `orgId leaked into ${u}`);
  }
  assert.deepEqual(res.windows, [
    {
      id: "credits-cycle",
      label: "Credits (cycle)",
      used: 0,
      limit: 70,
      unit: "dollars",
      resetsAt: "2026-09-08T07:45:24.000Z",
    },
  ]);
  assert.equal(res.message, "Plan: Individual Goat");
});

test("without a currentPeriodEnd the reset falls back to start + 1 month", async () => {
  const responses = { ...happy };
  responses["https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-123"] =
    json({
      data: { currentPeriodStart: "2026-08-01T00:00:00.000Z", planId: "pro" },
    });
  const res = await adapter().keyUsage(usageCtx(responses));
  assert.equal(res.windows[0].resetsAt, "2026-09-01T00:00:00.000Z");
});

test("a subscriptions 500 surfaces HTTP 500", async () => {
  const res = await adapter().keyUsage(
    usageCtx({
      "https://api.commandcode.ai/alpha/whoami": json({ org: { id: "org-123" } }),
      "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-123": {
        status: 500,
        ok: false,
      },
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /HTTP 500/);
});

test("no credit data and no spend means no balance to draw", async () => {
  const res = await adapter().keyUsage(
    usageCtx({
      "https://api.commandcode.ai/alpha/whoami": json({ org: { id: "org-123" } }),
      "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-123":
        json({}),
      "https://api.commandcode.ai/alpha/billing/credits?orgId=org-123": json({
        credits: {},
      }),
      "https://api.commandcode.ai/alpha/usage/summary?orgId=org-123&since=":
        json({}),
    }),
  );
  assert.deepEqual(res, {
    windows: [],
    unavailable: true,
    message: "No credit balance returned.",
  });
});

test("a transport failure degrades to unavailable, never throws", async () => {
  const res = await adapter().keyUsage(
    usageCtx(() => {
      throw new Error("boom");
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /Usage query failed: boom/);
});

test("a non-JSON usage body degrades to unavailable", async () => {
  const res = await adapter().keyUsage(
    usageCtx({
      "https://api.commandcode.ai/alpha/whoami": {
        json: () => {
          throw new Error("bad json");
        },
      },
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /non-JSON/);
});
