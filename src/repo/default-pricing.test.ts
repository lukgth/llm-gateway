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
    if (m.cacheWritePer1m != null) {
      assert.ok(
        m.cacheWritePer1m > 0,
        `${m.id} cacheWritePer1m (${m.cacheWritePer1m}) should be > 0`,
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
    ["claude-fable-5-1", 10, 50, 0.25],
    ["claude-mythos-5-1", 10, 50, 0.25],
    ["gpt-6-astra", 10, 50, 1],
    ["gpt-5.6-sol", 4, 20, 0.4],
    ["deepseek-v4-flash-vision-exp", 0.44, 1.32, 0.014],
    ["glm-5.3-flash", 0.15, 0.5, 0.03],
    ["gemini-3.8-flash", 1.5, 7.5, 0.15],
    ["qwen3.8-max-0902", 2, 6, undefined],
    ["qwen3.8-flash", 0.15, 0.47, undefined],
    ["qwen3.7-max", 2.5, 7.5, undefined],
    ["qwen3.6-max-preview", 1.3, 7.8, undefined],
    ["qwen3.7-flash", 0.03, 0.13, undefined],
    ["qwen3.7-plus", 0.5, 2, undefined],
    ["muse-spark-1.3", 1.25, 4.25, 0.15],
    ["muse-spark-1.3-contributor", 0.1, 0.2, 0.002],
    ["muse-spark-1.2", 1.25, 4.25, 0.15],
    ["muse-spark-1.2-contributor", 0.1, 0.2, 0.002],
    ["muse-spark-1.1", 1.25, 4.25, 0.15],
    ["kimi-k2.6", 0.95, 4, 0.16],
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

test("defaultPricingFor: resolves all Muse Spark tiers", () => {
  for (const id of [
    "muse-spark-1.3",
    "muse-spark-1.2",
    "muse-spark-1.1",
  ]) {
    const m = defaultPricingFor(id);
    assert.ok(m, `expected to resolve ${id}`);
    assert.equal(m!.promptPer1m, 1.25, `${id} promptPer1m`);
    assert.equal(m!.completionPer1m, 4.25, `${id} completionPer1m`);
    assert.equal(m!.cachedPer1m, 0.15, `${id} cachedPer1m`);
    assert.equal(m!.brand, "meta");
  }
  for (const id of [
    "muse-spark-1.3-contributor",
    "muse-spark-1.2-contributor",
  ]) {
    const m = defaultPricingFor(id);
    assert.ok(m, `expected to resolve ${id}`);
    assert.equal(m!.promptPer1m, 0.1, `${id} promptPer1m`);
    assert.equal(m!.completionPer1m, 0.2, `${id} completionPer1m`);
    assert.equal(m!.cachedPer1m, 0.002, `${id} cachedPer1m`);
    assert.equal(m!.brand, "meta");
  }
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

test("defaultPricingFor: 5.1 generation uses the 0.025x cache-read rate", () => {
  // $0.25, not the standard 0.1x ($1.00) - a regression here silently
  // quadruples cached-cost estimates for the newest Claude models.
  for (const id of ["claude-fable-5-1", "claude-mythos-5-1"]) {
    const m = defaultPricingFor(id);
    assert.ok(m, `expected to resolve ${id}`);
    assert.equal(m!.promptPer1m, 10);
    assert.equal(m!.completionPer1m, 50);
    assert.equal(m!.cachedPer1m, 0.25);
  }
});

test("defaultPricingFor: gpt-6-astra resolves the new flagship rate", () => {
  const m = defaultPricingFor("gpt-6-astra");
  assert.ok(m);
  assert.equal(m!.promptPer1m, 10);
  assert.equal(m!.completionPer1m, 50);
  assert.equal(m!.cachedPer1m, 1);
  assert.equal(m!.brand, "openai");
});

test("defaultPricingFor: glm-5.3-flash stores the list price, not the promo", () => {
  const m = defaultPricingFor("glm-5.3-flash");
  assert.ok(m);
  assert.equal(m!.promptPer1m, 0.15);
  assert.equal(m!.completionPer1m, 0.5);
  assert.equal(m!.cachedPer1m, 0.03);
});

test("defaultPricingFor: cache-write rates match published 5-minute/default-tier prices", () => {
  const cases: Array<[string, number]> = [
    // Anthropic 5m writes at 1.25x base.
    // https://platform.claude.com/docs/en/about-claude/pricing
    ["claude-fable-5", 12.5],
    ["claude-mythos-5-1", 12.5],
    ["claude-opus-5", 6.25],
    ["claude-opus-4-5", 6.25],
    ["claude-sonnet-5", 2.5],
    ["claude-sonnet-4-5", 3.75],
    ["claude-haiku-4-5", 1.25],
    // OpenAI GPT-5.6 generation and later, writes at 1.25x uncached input.
    // https://developers.openai.com/api/docs/guides/prompt-caching
    ["gpt-6-astra", 12.5],
    ["gpt-5.6-sol", 5],
    ["gpt-5.6-terra", 2.5],
    ["gpt-5.6-luna", 0.25],
    // MiniMax publishes a distinct cache-write rate for M2.7.
    // https://platform.minimax.io/docs/guides/pricing-paygo
    ["minimax-m2.7", 0.375],
  ];
  for (const [id, write] of cases) {
    const m = defaultPricingFor(id);
    assert.ok(m, `expected to resolve ${id}`);
    assert.equal(m!.cacheWritePer1m, write, `${id} cacheWritePer1m`);
  }
  // Earlier OpenAI generations and providers with no published write price
  // omit the field, so computeCostUsd falls back to the cached rate.
  for (const id of ["gpt-5.5", "deepseek-v4-flash", "gemini-3.7-flash"]) {
    const m = defaultPricingFor(id);
    assert.ok(m, `expected to resolve ${id}`);
    assert.equal(m!.cacheWritePer1m, undefined, `${id} cacheWritePer1m`);
  }
});
