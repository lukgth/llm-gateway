import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCostUsd, type ModelPricing } from "./pricing";

const full: ModelPricing = {
  alias: "test",
  promptPer1m: 0.15,
  completionPer1m: 0.6,
  cachedPer1m: 0.075,
  cacheWritePer1m: null,
  updatedAt: "",
};

const assertCost = (actual: number | null, expected: number) => {
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 1e-9,
    `expected ${expected}, got ${actual}`,
  );
};

test("computeCostUsd bills uncached input, cached input, and output separately", () => {
  // inputBillable = 1000 - 200 = 800
  // (800 * 0.15 + 200 * 0.075 + 500 * 0.6) / 1e6
  assertCost(computeCostUsd(full, 1000, 500, 200), 0.000435);
});

test("computeCostUsd returns null without prompt and completion rates", () => {
  assert.equal(computeCostUsd(null, 1000, 500, 200), null);
  assert.equal(
    computeCostUsd({ ...full, completionPer1m: null }, 1000, 500, 200),
    null,
  );
});

test("computeCostUsd falls back to the prompt rate for cached tokens", () => {
  // (800 * 0.15 + 200 * 0.15 + 500 * 0.6) / 1e6
  assertCost(
    computeCostUsd({ ...full, cachedPer1m: null }, 1000, 500, 200),
    0.00045,
  );
});

test("computeCostUsd bills zero when no token counts are reported", () => {
  assert.equal(computeCostUsd(full, null, null, null), 0);
});

test("computeCostUsd subtracts cache writes from input and bills them at the cached rate", () => {
  // inputBillable = 1000 - 200 - 100 = 700
  // (700 * 0.15 + 200 * 0.075 + 100 * 0.075 + 500 * 0.6) / 1e6
  assertCost(
    computeCostUsd({ ...full, cacheWritePer1m: null }, 1000, 500, 200, 100),
    0.0004275,
  );
});

test("computeCostUsd uses a distinct cache-write rate when configured", () => {
  // (700 * 0.15 + 200 * 0.075 + 100 * 0.5 + 500 * 0.6) / 1e6
  assertCost(
    computeCostUsd({ ...full, cacheWritePer1m: 0.5 }, 1000, 500, 200, 100),
    0.00047,
  );
});
