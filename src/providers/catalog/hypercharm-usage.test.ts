// HyperCharm key usage: one GET {origin}{basePath}/credits returning
// { "balance": <number> } (Hypercredits). The bar ceiling is the operator-
// configured creditsPerPeriod (default 100) since the API returns no limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hypercharm } from "./hypercharm";
import type { UsageCtx, AdapterHttpResponse } from "../base";
import type { Provider } from "../../types";

const provider = {
  id: "hypercharm-test",
  name: "HyperCharm",
  catalogId: "hypercharm",
  baseUrl: "https://hyper.charm.land",
  basePath: "/v1",
} as Provider;

// Builds a UsageCtx whose transport returns `resp` (or dispatches on the URL)
// and records every call's URL + auth header for assertions.
function usageCtx(
  resp:
    | Partial<AdapterHttpResponse>
    | ((url: string) => Partial<AdapterHttpResponse>),
  over: Partial<UsageCtx> = {},
  seen?: { urls: string[]; auth?: string },
): UsageCtx {
  const base = (over.provider ?? provider) as Provider;
  return {
    provider: base,
    keyMetadata: {},
    apiKey: "sk-hyper-test",
    mask: "sk-hyper-…st",
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
      const r = typeof resp === "function" ? resp(url) : resp;
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

test("supportsKeyUsage is true", () => {
  assert.equal(hypercharm.supportsKeyUsage(usageCtx({})), true);
});

test("a numeric balance reports remaining Hypercredits with one Bearer GET", async () => {
  const seen = { urls: [] as string[], auth: undefined as string | undefined };
  const result = await hypercharm.keyUsage(usageCtx(json({ balance: 87 }), {}, seen));
  assert.equal(result.unavailable, undefined);
  assert.equal(result.message, "87 Hypercredits remaining");
  assert.deepEqual(result.windows, [{ id: "hypercredits", label: "Balance", used: 0.65, limit: 5, unit: "dollars" }]);
  assert.deepEqual(seen.urls, ["https://hyper.charm.land/v1/credits"]);
  assert.equal(seen.auth, "Bearer sk-hyper-test");
});

test("the balance URL follows the configured base URL and basePath", async () => {
  const seen = { urls: [] as string[], auth: undefined as string | undefined };
  const edited = {
    ...provider,
    baseUrl: "https://hyper.mirror.example",
    basePath: "/v2",
  } as Provider;
  const result = await hypercharm.keyUsage(usageCtx(json({ balance: 5 }), { provider: edited }, seen));
  assert.deepEqual(seen.urls, ["https://hyper.mirror.example/v2/credits"]);
  assert.deepEqual(result.windows, [{ id: "hypercredits", label: "Balance", used: 4.75, limit: 5, unit: "dollars" }]);
});

test("tier allocation from providerConfig creditsPerPeriod", async () => {
  const withConfig = {
    ...provider,
    providerConfig: { creditsPerPeriod: 250 },
  } as Provider;
  const result = await hypercharm.keyUsage(
    usageCtx(json({ balance: 83.6 }), { provider: withConfig }),
  );
  assert.equal(result.message, "83.60 Hypercredits remaining");
  assert.deepEqual(result.windows, [{ id: "hypercredits", label: "Balance", used: 8.32, limit: 12.5, unit: "dollars" }]);
});

test("bundle credits over allocation still report correctly", async () => {
  const result = await hypercharm.keyUsage(usageCtx(json({ balance: 300 })));
  assert.equal(result.message, "300 Hypercredits remaining");
  assert.deepEqual(result.windows, [{ id: "hypercredits", label: "Balance", used: 0, limit: 15, unit: "dollars" }]);
});

test("a disabled key is reported without querying the upstream", async () => {
  const seen = { urls: [] as string[] };
  const result = await hypercharm.keyUsage(
    usageCtx(
      {},
      {
        enabled: false,
        request: async () => {
          throw new Error("must not be called");
        },
      },
      seen,
    ),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Key disabled - usage not queried.");
  assert.deepEqual(seen.urls, []);
});

test("a 401 surfaces HTTP 401 as unavailable", async () => {
  const result = await hypercharm.keyUsage(
    usageCtx({ ok: false, status: 401, json: () => ({ error: "bad key" }) }),
  );
  assert.equal(result.unavailable, true);
  assert.match(result.message ?? "", /HTTP 401/);
});

test("a non-JSON body degrades to unavailable", async () => {
  const result = await hypercharm.keyUsage(
    usageCtx({
      json: () => {
        throw new Error("Unexpected token");
      },
    }),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Usage endpoint returned non-JSON.");
});

test("a transport failure degrades to unavailable, never throws", async () => {
  const result = await hypercharm.keyUsage(
    usageCtx(
      {},
      {
        request: async () => {
          throw new Error("ECONNRESET");
        },
      },
    ),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.message, "Usage query failed: ECONNRESET");
});

test("a missing or non-numeric balance is unavailable", async () => {
  for (const body of [{}, { balance: "100" }, { balance: null }, { balance: Number.NaN }]) {
    const result = await hypercharm.keyUsage(usageCtx(json(body)));
    assert.equal(result.unavailable, true, JSON.stringify(body));
    assert.equal(result.message, "No credit balance returned.");
  }
});

test("a zero balance flags insufficient credits", async () => {
  const result = await hypercharm.keyUsage(usageCtx(json({ balance: 0 })));
  assert.deepEqual(result.windows, [{ id: "hypercredits", label: "Balance", used: 5, limit: 5, unit: "dollars" }]);
  assert.equal(
    result.message,
    "0 Hypercredits remaining - insufficient for API calls",
  );
});

test("a fractional balance renders with two decimals", async () => {
  const result = await hypercharm.keyUsage(usageCtx(json({ balance: 12.5 })));
  assert.equal(result.message, "12.50 Hypercredits remaining");
});
