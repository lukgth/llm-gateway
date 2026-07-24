import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_PRICING, defaultPricingFor } from "./default-pricing";

test("DEFAULT_MODEL_PRICING: every entry has positive prompt/completion rates and a sane cached rate", () => {
  for (const m of DEFAULT_MODEL_PRICING) {
    assert.ok(m.id, "entry missing id");
    assert.ok(m.label, `${m.id} missing label`);
    assert.ok(m.brand, `${m.id} missing brand`);
    assert.ok(
      m.promptPer1m > 0,
      `${m.id} promptPer1m should be positive, got ${m.promptPer1m}`,
    );
    assert.ok(
      m.completionPer1m > 0,
      `${m.id} completionPer1m should be positive, got ${m.completionPer1m}`,
    );
    if (m.cachedPer1m != null) {
      assert.ok(
        m.cachedPer1m > 0 && m.cachedPer1m <= m.promptPer1m,
        `${m.id} cachedPer1m (${m.cachedPer1m}) should be > 0 and <= promptPer1m (${m.promptPer1m})`,
      );
    }
  }
});

test("DEFAULT_MODEL_PRICING: no duplicate ids", () => {
  const ids = DEFAULT_MODEL_PRICING.map((m) => m.id);
  assert.equal(ids.length, new Set(ids).size, "duplicate id in table");
});

test("defaultPricingFor: exact id match", () => {
  const m = defaultPricingFor("claude-opus-5");
  assert.ok(m);
  assert.equal(m!.label, "Claude Opus 5");
  assert.equal(m!.promptPer1m, 5);
  assert.equal(m!.completionPer1m, 25);
  assert.equal(m!.cachedPer1m, 0.5);
});

test("defaultPricingFor: date-suffixed alias tolerantly matches the base entry", () => {
  const m = defaultPricingFor("claude-sonnet-5-20260629");
  assert.ok(m);
  assert.equal(m!.id, "claude-sonnet-5");
});

test("defaultPricingFor: entries with no published cache rate omit cachedPer1m", () => {
  const m = defaultPricingFor("gemini-3.1-pro");
  assert.ok(m);
  assert.equal(m!.cachedPer1m, undefined);
});

test("defaultPricingFor: unknown model returns undefined", () => {
  assert.equal(defaultPricingFor("not-a-real-model-xyz"), undefined);
});

test("defaultPricingFor: covers every provider family referenced in the catalog brand set", () => {
  const brands = new Set(DEFAULT_MODEL_PRICING.map((m) => m.brand));
  for (const expected of ["anthropic", "openai", "deepseek", "zai"]) {
    assert.ok(brands.has(expected), `expected a ${expected} entry`);
  }
});
