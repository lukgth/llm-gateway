// Ollama Cloud key usage: two documented probes per key -
//   GET /api/balance       -> included credits ({ balance_usd, allowance_usd,
//                             period }) or legacy { session, weekly } of
//                             { remaining_percent, resets_at }, plus the
//                             one-shot purchased credit balance.
//   GET /api/usage?range=24h -> recorded spend totals for the trailing 24h.
// The balance drives the bars; the usage totals only fill the message line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ollamaCloud } from "./ollama";
import type { UsageCtx, AdapterHttpResponse } from "../base";
import type { Provider } from "../../types";

const provider = {
  id: "ollama-cloud-test",
  name: "Ollama Cloud",
  catalogId: "ollama-cloud",
  baseUrl: "https://ollama.example.com",
  basePath: "",
} as Provider;

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

// Builds a UsageCtx whose transport dispatches on the request URL and records
// every URL + init it saw, so path/auth/signal assertions stay cheap.
function usageCtx(
  route: (url: string) => AdapterHttpResponse | Promise<AdapterHttpResponse>,
  over: Partial<UsageCtx> = {},
  seen?: { calls: { url: string; init: Parameters<UsageCtx["request"]>[1] }[] },
): UsageCtx {
  return {
    provider,
    keyMetadata: {},
    apiKey: "sk-ollama-test",
    mask: "sk-…est",
    enabled: true,
    seed: 1,
    baseUrl: provider.baseUrl,
    basePath: "",
    resolve: (t) => provider.baseUrl + (typeof t === "string" ? t : ""),
    request: async (url, init) => {
      seen?.calls.push({ url, init });
      return route(url);
    },
    ...over,
  } as UsageCtx;
}

// Credits-plan balance payload matching the documented shape.
function creditsBalance(
  balanceUsd: number,
  allowanceUsd: number,
  purchasedUsd = 0,
) {
  return {
    included: {
      balance_usd: balanceUsd,
      allowance_usd: allowanceUsd,
      period: {
        from: "2026-10-06T22:27:57.554265Z",
        until: "2026-11-06T22:27:57.554265Z",
      },
    },
    purchased: { balance_usd: purchasedUsd },
  };
}

const noActivity = {
  range: "24h",
  scope: "self",
  granularity: "hour",
  totals: {
    request_count: 0,
    usage_usd: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
  },
  buckets: [],
};

function twoRoutes(
  balance: AdapterHttpResponse,
  usage: AdapterHttpResponse | (() => Promise<AdapterHttpResponse>),
) {
  return (url: string) => {
    if (url.endsWith("/api/balance")) return balance;
    if (url.includes("/api/usage")) {
      return typeof usage === "function" ? usage() : usage;
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test("ollamaCloud.supportsKeyUsage is true (opts into the dashboard)", () => {
  assert.equal(
    ollamaCloud.supportsKeyUsage(
      usageCtx(() => {
        throw new Error("unused");
      }),
    ),
    true,
  );
});

test("ollamaCloud.keyUsage: disabled key -> unavailable without a network call", async () => {
  let called = false;
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      () => {
        called = true;
        throw new Error("must not be called");
      },
      { enabled: false },
    ),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
  assert.equal(called, false);
});

test("ollamaCloud.keyUsage: queries /api/balance then /api/usage?range=24h with Bearer auth and the forwarded signal", async () => {
  const controller = new AbortController();
  const seen = {
    calls: [] as { url: string; init: Parameters<UsageCtx["request"]>[1] }[],
  };
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(2.5, 2.5)),
        jsonResponse(200, noActivity),
      ),
      { signal: controller.signal },
      seen,
    ),
  );
  assert.deepEqual(
    seen.calls.map((c) => c.url),
    [
      "https://ollama.example.com/api/balance",
      "https://ollama.example.com/api/usage?range=24h",
    ],
  );
  for (const { init } of seen.calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "Bearer sk-ollama-test");
    assert.equal(init.headers.accept, "application/json");
    assert.equal(init.signal, controller.signal);
  }
  assert.equal(res.unavailable, undefined);
});

test("ollamaCloud.keyUsage: credits plan -> included-credits dollar bar topped up by the period's own reset timestamp", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(2.49657, 2.5)),
        jsonResponse(200, noActivity),
      ),
    ),
  );
  assert.equal(res.windows.length, 1);
  const included = res.windows[0];
  assert.equal(included.id, "included");
  assert.equal(included.label, "Included credits");
  assert.equal(included.unit, "dollars");
  assert.equal(included.limit, 2.5);
  // Used = allowance - remaining, not the raw remaining balance.
  assert.equal(included.used, 0.00343);
  // Upstream `until` has microseconds; it must normalise to a real ISO instant.
  assert.equal(included.resetsAt, "2026-11-06T22:27:57.554Z");
});

test("ollamaCloud.keyUsage: a balance above the allowance clamps used to [0, limit]", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(3, 2.5)),
        jsonResponse(200, noActivity),
      ),
    ),
  );
  assert.equal(res.windows[0].used, 0);
  assert.equal(res.windows[0].limit, 2.5);
});

test("ollamaCloud.keyUsage: legacy plan -> session/weekly bars from remaining_percent with upstream resets_at", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, {
          included: {
            session: {
              remaining_percent: 75,
              resets_at: "2026-10-01T07:00:00Z",
            },
            weekly: {
              remaining_percent: 40,
              resets_at: "2026-10-05T00:00:00Z",
            },
          },
          purchased: { balance_usd: 0 },
        }),
        jsonResponse(200, noActivity),
      ),
    ),
  );
  assert.deepEqual(
    res.windows.map((w) => w.id),
    ["session", "weekly"],
  );
  // remaining_percent is what REMAINS, so used is its complement.
  assert.equal(res.windows[0].used, 25);
  assert.equal(res.windows[0].limit, 100);
  assert.equal(res.windows[0].unit, "percent");
  assert.equal(res.windows[0].resetsAt, "2026-10-01T07:00:00.000Z");
  assert.equal(res.windows[1].used, 60);
  assert.equal(res.windows[1].resetsAt, "2026-10-05T00:00:00.000Z");
});

test("ollamaCloud.keyUsage: invalid legacy entries are skipped independently", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, {
          included: {
            session: {
              remaining_percent: 150,
              resets_at: "2026-10-01T07:00:00Z",
            },
            weekly: { remaining_percent: 12.5, resets_at: "not-a-date" },
          },
        }),
        jsonResponse(200, noActivity),
      ),
    ),
  );
  // Out-of-range session is dropped; weekly survives but without a bogus reset.
  assert.equal(res.windows.length, 1);
  assert.equal(res.windows[0].id, "weekly");
  assert.equal(res.windows[0].used, 87.5);
  assert.equal("resetsAt" in res.windows[0], false);
});

test("ollamaCloud.keyUsage: usage totals render a 24h spend line", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(2.49, 2.5)),
        jsonResponse(200, {
          totals: {
            request_count: 15,
            usage_usd: 0.01718,
            input_tokens: 106000,
            cached_input_tokens: 46000,
            output_tokens: 13600,
          },
        }),
      ),
    ),
  );
  assert.equal(
    res.message,
    "24h: 15 requests · $0.02 · 106k in (46k cached) / 13.6k out",
  );
});

test("ollamaCloud.keyUsage: sub-cent spend keeps its precision; idle usage omits the token part", async () => {
  const tiny = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(2.49, 2.5)),
        jsonResponse(200, {
          totals: {
            request_count: 1,
            usage_usd: 0.0004,
            input_tokens: 0,
            output_tokens: 0,
          },
        }),
      ),
    ),
  );
  assert.equal(tiny.message, "24h: 1 request · $0.0004");

  const idle = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(2.49, 2.5)),
        jsonResponse(200, noActivity),
      ),
    ),
  );
  assert.equal(idle.message, "24h: 0 requests · $0.00");
});

test("ollamaCloud.keyUsage: purchased credits are a note, not a bar", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(2.4, 2.5, 25)),
        jsonResponse(200, noActivity),
      ),
    ),
  );
  assert.equal(res.windows.length, 1);
  assert.equal(
    res.message,
    "24h: 0 requests · $0.00 · Purchased credits: $25.00",
  );
});

test("ollamaCloud.keyUsage: a failing /api/usage keeps the balance bars", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(jsonResponse(200, creditsBalance(2.4, 2.5)), async () => {
        throw new Error("ECONNRESET");
      }),
    ),
  );
  assert.equal(res.unavailable, undefined);
  assert.equal(res.windows.length, 1);
  assert.equal(res.message, undefined);

  const http500 = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, creditsBalance(2.4, 2.5)),
        jsonResponse(500, { error: "x" }),
      ),
    ),
  );
  assert.equal(http500.windows.length, 1);
  assert.equal(http500.message, undefined);
});

test("ollamaCloud.keyUsage: non-2xx balance -> unavailable with the HTTP status, usage not queried", async () => {
  const urls: string[] = [];
  const res = await ollamaCloud.keyUsage(
    usageCtx((url) => {
      urls.push(url);
      return jsonResponse(403, { error: "denied" });
    }),
  );
  assert.equal(res.unavailable, true);
  assert.equal(res.windows.length, 0);
  assert.match(res.message ?? "", /HTTP 403/);
  assert.deepEqual(urls, ["https://ollama.example.com/api/balance"]);
});

test("ollamaCloud.keyUsage: balance request rejection -> unavailable, error surfaced", async () => {
  const res = await ollamaCloud.keyUsage(
    usageCtx(() => {
      throw new Error("ECONNREFUSED");
    }),
  );
  assert.equal(res.unavailable, true);
  assert.match(res.message ?? "", /ECONNREFUSED/);
});

test("ollamaCloud.keyUsage: malformed balance JSON and an empty envelope -> unavailable, no throw", async () => {
  const malformed = await ollamaCloud.keyUsage(
    usageCtx((url) => {
      if (url.endsWith("/api/balance")) {
        return {
          status: 200,
          ok: true,
          ms: 1,
          text: "not json",
          json: () => {
            throw new SyntaxError("Unexpected token");
          },
        };
      }
      throw new Error("must not be queried");
    }),
  );
  assert.equal(malformed.unavailable, true);
  assert.equal(malformed.windows.length, 0);

  const empty = await ollamaCloud.keyUsage(
    usageCtx(
      twoRoutes(
        jsonResponse(200, { included: {}, purchased: { balance_usd: 0 } }),
        jsonResponse(200, { totals: undefined }),
      ),
    ),
  );
  assert.equal(empty.unavailable, true);
  assert.equal(empty.windows.length, 0);
  assert.equal(empty.message, "Could not parse quota data.");
});
