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

test("defaultPricingFor: claude-sonnet-5 resolves the current 2/10/0.2 standard rate", () => {
  const m = defaultPricingFor("claude-sonnet-5");
  assert.ok(m);
  assert.equal(m!.promptPer1m, 2);
  assert.equal(m!.completionPer1m, 10);
  assert.equal(m!.cachedPer1m, 0.2);
});

test("defaultPricingFor: date-suffixed alias tolerantly matches the base entry", () => {
  const m = defaultPricingFor("claude-sonnet-5-20260629");
  assert.ok(m);
  assert.equal(m!.id, "claude-sonnet-5");
  assert.equal(m!.promptPer1m, 2);
  assert.equal(m!.completionPer1m, 10);
  assert.equal(m!.cachedPer1m, 0.2);
});

test("defaultPricingFor: entries with no published cache rate omit cachedPer1m", () => {
  const m = defaultPricingFor("gemini-3.1-pro");
  assert.ok(m);
  assert.equal(m!.cachedPer1m, undefined);
});

test("defaultPricingFor: resolves exact values for every newly added id", () => {
  const cases: Array<
    [string, number, number, number | undefined]
  > = [
    ["gpt-5.5", 5, 30, 0.5],
    ["gpt-5.5-pro", 30, 180, undefined],
    ["gpt-5.4", 2.5, 15, 0.25],
    ["gpt-5.4-mini", 0.75, 4.5, 0.075],
    ["gpt-5.4-nano", 0.2, 1.25, 0.02],
    ["gpt-5.4-pro", 30, 180, undefined],
    ["grok-4.6", 2, 6, 0.5],
    ["gemini-3.7-flash", 1.5, 7.5, 0.15],
    ["gemini-3.6-flash", 1.5, 7.5, 0.15],
    ["gemini-3.5-flash", 1.5, 9, 0.15],
    ["gemini-3.1-pro-preview", 2, 12, 0.2],
    ["kimi-k3", 3, 15, 0.3],
    ["kimi-k2.7-code", 0.95, 4, 0.19],
    ["kimi-k2.7-code-highspeed", 1.9, 8, 0.38],
    ["minimax-m3", 0.3, 1.2, 0.06],
    ["minimax-m2.7", 0.3, 1.2, 0.06],
  ];
  for (const [id, prompt, completion, cached] of cases) {
    const m = defaultPricingFor(id);
    assert.ok(m, `expected to resolve ${id}`);
    assert.equal(m!.promptPer1m, prompt, `${id} promptPer1m`);
    assert.equal(m!.completionPer1m, completion, `${id} completionPer1m`);
    assert.equal(m!.cachedPer1m, cached, `${id} cachedPer1m`);
  }
});

test("defaultPricingFor: unknown model returns undefined", () => {
  assert.equal(defaultPricingFor("not-a-real-model-xyz"), undefined);
});

test("defaultPricingFor: qwen3.8-max resolves list price with no cached rate", () => {
  const m = defaultPricingFor("qwen3.8-max");
  assert.ok(m);
  assert.equal(m!.promptPer1m, 2);
  assert.equal(m!.completionPer1m, 6);
  assert.equal(m!.cachedPer1m, undefined);
});

test("defaultPricingFor: DeepSeek entries resolve the conservative peak scalars", () => {
  const pro = defaultPricingFor("deepseek-v4-pro");
  assert.ok(pro);
  assert.equal(pro!.promptPer1m, 1.32);
  assert.equal(pro!.completionPer1m, 3.96);
  assert.equal(pro!.cachedPer1m, 0.044);

  const flash = defaultPricingFor("deepseek-v4-flash");
  assert.ok(flash);
  assert.equal(flash!.promptPer1m, 0.44);
  assert.equal(flash!.completionPer1m, 1.32);
  assert.equal(flash!.cachedPer1m, 0.014);
});

test("defaultPricingFor: gemini-3.1-pro-preview resolves the exact preview id", () => {
  const preview = defaultPricingFor("gemini-3.1-pro-preview");
  assert.ok(preview);
  assert.equal(preview!.id, "gemini-3.1-pro-preview");
  // Distinct from the GA entry of the same family.
  assert.notEqual(preview!.id, defaultPricingFor("gemini-3.1-pro")!.id);
});

test("defaultPricingFor: glm-5.3 resolves the same published rate as glm-5.2", () => {
  const fiveThree = defaultPricingFor("glm-5.3");
  assert.ok(fiveThree);
  assert.equal(fiveThree!.promptPer1m, 1.4);
  assert.equal(fiveThree!.completionPer1m, 4.4);
  assert.equal(fiveThree!.cachedPer1m, 0.26);

  const fiveTwo = defaultPricingFor("glm-5.2");
  assert.ok(fiveTwo);
  assert.equal(fiveTwo!.promptPer1m, 1.4);
  assert.equal(fiveTwo!.completionPer1m, 4.4);
  assert.equal(fiveTwo!.cachedPer1m, 0.26);
});

test("defaultPricingFor: resolves both Muse Spark tiers", () => {
  const normal = defaultPricingFor("muse-spark-2.1");
  assert.ok(normal);
  assert.equal(normal!.promptPer1m, 1.25);
  assert.equal(normal!.completionPer1m, 4.25);
  assert.equal(normal!.cachedPer1m, 0.15);

  const contributor = defaultPricingFor("muse-spark-2.1-contributor");
  assert.ok(contributor);
  assert.equal(contributor!.promptPer1m, 0.1);
  assert.equal(contributor!.completionPer1m, 0.2);
  assert.equal(contributor!.cachedPer1m, 0.002);
  assert.equal(contributor!.brand, "meta");
});

test("defaultPricingFor: covers every provider family referenced in the catalog brand set", () => {
  const brands = new Set(DEFAULT_MODEL_PRICING.map((m) => m.brand));
  for (const expected of [
    "anthropic",
    "openai",
    "deepseek",
    "zai",
    "xai",
    "gemini",
    "kimi",
    "minimax",
    "qwen",
  ]) {
    assert.ok(brands.has(expected), `expected a ${expected} entry`);
  }
});
