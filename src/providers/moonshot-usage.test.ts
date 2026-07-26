// Moonshot key usage: GET {origin}{basePath}/users/me/balance.
//
// Success envelope (amounts in CNY):
//   { code: 0, data: { available_balance, voucher_balance, cash_balance },
//     scode: "0x0", status: true }
// Failure: { error: { message, type } } — the same envelope the chat endpoints
// use, served with a 401.
//
// Reported as a message rather than a window, like deepseek.ts: this is a
// credit balance, not a rate-limit quota, so there is no ceiling to draw a bar
// against and inventing one would misrepresent it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "./index";
import type { UsageCtx, AdapterHttpResponse } from "./base";
import type { Provider } from "../types";

const adapter = () => getAdapter("moonshot")!;

const provider = {
  id: "m",
  name: "moonshot",
  baseUrl: "https://api.moonshot.cn",
  basePath: "/v1",
  catalogId: "moonshot",
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

const ok = (data: Record<string, number>) => ({
  json: () => ({ code: 0, data, scode: "0x0", status: true }),
});

test("supportsKeyUsage is true", () => {
  assert.equal(adapter().supportsKeyUsage(usageCtx({})), true);
});

test("a successful balance is reported in CNY", async () => {
  const r = await adapter().keyUsage(
    usageCtx(
      ok({
        available_balance: 546.2228,
        voucher_balance: 0,
        cash_balance: 546.2228,
      }),
    ),
  );
  assert.equal(r.unavailable, undefined);
  assert.equal(r.message, "546.22 CNY remaining");
  assert.deepEqual(r.windows, []);
});

test("the request goes to {origin}{basePath}/users/me/balance with bearer auth", async () => {
  const seen: { url?: string; auth?: string } = {};
  await adapter().keyUsage(usageCtx(ok({ available_balance: 1 }), {}, seen));
  assert.equal(seen.url, "https://api.moonshot.cn/v1/users/me/balance");
  assert.equal(seen.auth, "Bearer sk-test");
});

test("the URL follows the configured base URL, not a hardcoded host", async () => {
  // The base URL is an editable field and both regions serve this path, so
  // pinning .cn would query the wrong account for an .ai-configured provider.
  const intl = { ...provider, baseUrl: "https://api.moonshot.ai" } as Provider;
  const seen: { url?: string } = {};
  await adapter().keyUsage(
    usageCtx(ok({ available_balance: 1 }), { provider: intl }, seen),
  );
  assert.equal(seen.url, "https://api.moonshot.ai/v1/users/me/balance");
});

test("a voucher balance is broken out; a cash-only account is not", async () => {
  const split = await adapter().keyUsage(
    usageCtx(
      ok({
        available_balance: 120.5,
        voucher_balance: 100,
        cash_balance: 20.5,
      }),
    ),
  );
  assert.equal(
    split.message,
    "120.50 CNY remaining · voucher 100.00 CNY · cash 20.50 CNY",
  );
  const cashOnly = await adapter().keyUsage(
    usageCtx(
      ok({ available_balance: 10, voucher_balance: 0, cash_balance: 10 }),
    ),
  );
  assert.equal(cashOnly.message, "10.00 CNY remaining");
});

test("a zero or negative balance is flagged as unusable", async () => {
  // Moonshot lets an account go into arrears, so this must not be clamped.
  const neg = await adapter().keyUsage(
    usageCtx(ok({ available_balance: -3.2 })),
  );
  assert.match(neg.message ?? "", /^-3\.20 CNY remaining - insufficient/);
  const zero = await adapter().keyUsage(usageCtx(ok({ available_balance: 0 })));
  assert.match(zero.message ?? "", /insufficient for API calls$/);
});

test("a 401 surfaces the upstream's own message, not a bare status", async () => {
  const r = await adapter().keyUsage(
    usageCtx({
      ok: false,
      status: 401,
      json: () => ({
        error: {
          message: "Invalid Authentication",
          type: "invalid_authentication_error",
        },
      }),
    }),
  );
  assert.equal(r.unavailable, true);
  assert.equal(
    r.message,
    "Balance endpoint: Invalid Authentication (HTTP 401)",
  );
});

test("a 200 carrying a logical failure is treated as unavailable", async () => {
  const r = await adapter().keyUsage(
    usageCtx({
      json: () => ({ code: 500, status: false, error: { message: "boom" } }),
    }),
  );
  assert.equal(r.unavailable, true);
  assert.equal(r.message, "boom");
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

  const noData = await adapter().keyUsage(
    usageCtx({ json: () => ({ code: 0, status: true, data: {} }) }),
  );
  assert.equal(noData.unavailable, true);
  assert.match(noData.message ?? "", /parse/i);
});
