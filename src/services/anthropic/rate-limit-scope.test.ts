import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAnthropicRateLimit } from "./rate-limit-scope";

const now = 1_700_000_000_000;
const reset = Math.floor((now + 3_600_000) / 1000); // Fable 7d_oi reset (~1h out)
const fiveHourReset = Math.floor((now + 900_000) / 1000); // base 5h reset (~15m)
const headers = (overrides: Record<string, string> = {}) => ({
  "anthropic-ratelimit-unified-status": "rate_limited",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.5",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-utilization": "0.9",
  "anthropic-ratelimit-unified-7d_oi-status": "rejected",
  "anthropic-ratelimit-unified-7d_oi-utilization": "1",
  "anthropic-ratelimit-unified-7d_oi-reset": String(reset),
  ...overrides,
});

function classify(
  overrides: Partial<Parameters<typeof classifyAnthropicRateLimit>[0]> = {},
) {
  return classifyAnthropicRateLimit(
    {
      status: 429,
      catalogId: "claude-code",
      upstreamModel: "claude-fable-5",
      headers: headers(),
      ...overrides,
    },
    now,
  );
}

test("classifies 7d_oi-only exhaustion as Fable-scoped (base stays usable)", () => {
  assert.deepEqual(classify(), {
    scope: "model",
    modelClass: "fable",
    resetAt: reset * 1000,
    reason: "Fable 7d_oi exhausted while base 5h/7d quota remains available",
  });
});

test("classification is header-driven, not keyed on the requested model", () => {
  // Same 7d_oi-only exhaustion → Fable-scoped regardless of which model asked,
  // so a base request can never inherit a global (multi-day) lock from 7d_oi.
  assert.equal(classify({ upstreamModel: "claude-mythos-5" }).scope, "model");
  assert.equal(
    classify({ upstreamModel: "claude-mythos-preview" }).scope,
    "model",
  );
  assert.equal(classify({ upstreamModel: "claude-opus-4-8" }).scope, "model");
  // But a non-429 or a non-Claude-Code provider is always global.
  assert.equal(classify({ catalogId: "anthropic" }).scope, "global");
  assert.equal(classify({ status: 500 }).scope, "global");
});

test("base window exhaustion is global — with the BASE reset, not 7d_oi's", () => {
  // 5h rejected (15m reset) AND 7d_oi rejected (1h reset). The GLOBAL cooldown
  // must track the base 5h window, and a SEPARATE Fable reset is reported so the
  // caller can layer a premium-only cooldown on top.
  const result = classify({
    headers: headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(fiveHourReset),
    }),
  });
  assert.equal(result.scope, "global");
  if (result.scope === "global") {
    assert.equal(result.baseResetAt, fiveHourReset * 1000); // 15m, NOT 1h/3d
    assert.equal(result.fableResetAt, reset * 1000); // premium tracked separately
  }
});

test("base exhausted without 7d_oi exhaustion carries no separate Fable reset", () => {
  const result = classify({
    headers: headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(fiveHourReset),
      "anthropic-ratelimit-unified-7d_oi-status": "allowed",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.3",
    }),
  });
  assert.equal(result.scope, "global");
  if (result.scope === "global") {
    assert.equal(result.baseResetAt, fiveHourReset * 1000);
    assert.equal(result.fableResetAt, undefined);
  }
});

test("weekly-window exhaustion also counts as base-global", () => {
  const weeklyReset = Math.floor((now + 2 * 86_400_000) / 1000);
  const result = classify({
    headers: headers({
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d-utilization": "1",
      "anthropic-ratelimit-unified-7d-reset": String(weeklyReset),
    }),
  });
  assert.equal(result.scope, "global");
  if (result.scope === "global")
    assert.equal(result.baseResetAt, weeklyReset * 1000);
});

test("utilization-only signals are accepted conservatively", () => {
  const utilizationOnly = headers();
  for (const key of ["5h", "7d", "7d_oi"])
    delete (utilizationOnly as Record<string, string>)[
      `anthropic-ratelimit-unified-${key}-status`
    ];
  // 7d_oi util = 1, base utils < 1 → Fable-scoped.
  assert.equal(classify({ headers: utilizationOnly }).scope, "model");
  // Push weekly util to 1 → base exhausted → global.
  (utilizationOnly as Record<string, string>)[
    "anthropic-ratelimit-unified-7d-utilization"
  ] = "1";
  assert.equal(classify({ headers: utilizationOnly }).scope, "global");
});

test("uses representative reset only when 7d_oi reset is absent", () => {
  const fallback = headers({
    "anthropic-ratelimit-unified-reset": String(reset + 60),
  });
  delete (fallback as Record<string, string>)[
    "anthropic-ratelimit-unified-7d_oi-reset"
  ];
  const result = classify({ headers: fallback });
  assert.equal(result.scope, "model");
  if (result.scope === "model")
    assert.equal(result.resetAt, (reset + 60) * 1000);
});

test("generic 429 with no exhausted window stays global with no reset", () => {
  const result = classify({
    headers: {
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d_oi-status": "allowed",
    },
  });
  assert.equal(result.scope, "global");
  if (result.scope === "global") {
    assert.equal(result.baseResetAt, undefined);
    assert.equal(result.fableResetAt, undefined);
  }
});

test("missing unified headers entirely stays global", () => {
  assert.equal(classify({ headers: {} }).scope, "global");
});
