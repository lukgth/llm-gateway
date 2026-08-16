// Stock default pricing for well-known models across providers - a reference
// table an operator can use to pre-fill a model's Prompt/Completion/Cached
// rates instead of looking them up by hand. Mirrors the shape of
// formats/anthropic/stock-models.ts (a static array + a tolerant lookup by
// alias), and the wire shape of repo/pricing.ts's ModelPricing so the admin
// UI/API can drop a matched entry straight into the same form fields.
//
// This is a REFERENCE only - it is never read by the request path or
// computeCostUsd. An operator (or the model editor's "Use default" button)
// copies a match into the model's own `model_pricing` row via upsertPricing;
// nothing here is authoritative until it's been copied in.
//
// Sourced from each provider's public pricing page; verify before relying on
// it for billing-critical decisions, and expect drift - providers change
// prices without notice more often than this table gets updated.

export interface DefaultModelPricing {
  /** Model id as the provider names it (matched tolerantly, see below). */
  id: string;
  /** Human label for the picker UI. */
  label: string;
  /** Catalog brand id (matches a src/providers/catalog/*.ts entry's `brand`),
   *  for grouping/iconography in the UI. */
  brand: string;
  promptPer1m: number;
  completionPer1m: number;
  /** Omitted when the provider publishes no cache-hit discount rate - the
   *  model editor's own placeholder ("defaults to prompt rate") already
   *  covers that case, so this table doesn't need to repeat promptPer1m here. */
  cachedPer1m?: number;
}

export const DEFAULT_MODEL_PRICING: DefaultModelPricing[] = [
  // --- Anthropic ------------------------------------------------------------
  // https://platform.claude.com/docs/en/about-claude/pricing
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    brand: "anthropic",
    promptPer1m: 10,
    completionPer1m: 50,
    cachedPer1m: 1,
  },
  {
    id: "claude-mythos-5",
    label: "Claude Mythos 5",
    brand: "anthropic",
    promptPer1m: 10,
    completionPer1m: 50,
    cachedPer1m: 1,
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    brand: "anthropic",
    promptPer1m: 5,
    completionPer1m: 25,
    cachedPer1m: 0.5,
  },
  {
    // Current standard rate (the previously announced temporary $3/$15 promo
    // has expired). https://platform.claude.com/docs/en/about-claude/pricing
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    brand: "anthropic",
    promptPer1m: 2,
    completionPer1m: 10,
    cachedPer1m: 0.2,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    brand: "anthropic",
    promptPer1m: 3,
    completionPer1m: 15,
    cachedPer1m: 0.3,
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    brand: "anthropic",
    promptPer1m: 3,
    completionPer1m: 15,
    cachedPer1m: 0.3,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    brand: "anthropic",
    promptPer1m: 1,
    completionPer1m: 5,
    cachedPer1m: 0.1,
  },

  // --- OpenAI -----------------------------------------------------------
  // https://developers.openai.com/api/docs/pricing,
  // https://openai.com/api/pricing, https://openai.com/index/gpt-5-6/
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    brand: "openai",
    promptPer1m: 5,
    completionPer1m: 30,
    cachedPer1m: 0.5,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    brand: "openai",
    promptPer1m: 2,
    completionPer1m: 12,
    cachedPer1m: 0.2,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    brand: "openai",
    promptPer1m: 0.2,
    completionPer1m: 1.2,
    cachedPer1m: 0.02,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    brand: "openai",
    promptPer1m: 5,
    completionPer1m: 30,
    cachedPer1m: 0.5,
  },
  {
    // OpenAI publishes no cached-input price for this model.
    id: "gpt-5.5-pro",
    label: "GPT-5.5 Pro",
    brand: "openai",
    promptPer1m: 30,
    completionPer1m: 180,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    brand: "openai",
    promptPer1m: 2.5,
    completionPer1m: 15,
    cachedPer1m: 0.25,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    brand: "openai",
    promptPer1m: 0.75,
    completionPer1m: 4.5,
    cachedPer1m: 0.075,
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    brand: "openai",
    promptPer1m: 0.2,
    completionPer1m: 1.25,
    cachedPer1m: 0.02,
  },
  {
    // OpenAI publishes no cached-input price for this model.
    id: "gpt-5.4-pro",
    label: "GPT-5.4 Pro",
    brand: "openai",
    promptPer1m: 30,
    completionPer1m: 180,
  },

  // --- DeepSeek -----------------------------------------------------------
  // https://api-docs.deepseek.com/quick_start/pricing/,
  // https://api-docs.deepseek.com/news/news260813 (peak/off-peak schedule,
  // effective Aug 16 2026). This table has no time/tier dimension, so we store
  // the official PEAK rate as the conservative scalar reference - we cannot
  // pick a rate by UTC time and may not invent an average.
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    brand: "deepseek",
    promptPer1m: 1.32,
    completionPer1m: 3.96,
    cachedPer1m: 0.044,
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    brand: "deepseek",
    promptPer1m: 0.44,
    completionPer1m: 1.32,
    cachedPer1m: 0.014,
  },

  // --- Z.AI / GLM -----------------------------------------------------------
  // https://docs.z.ai/guides/overview/pricing
  {
    id: "glm-5.2",
    label: "GLM-5.2",
    brand: "zai",
    promptPer1m: 1.4,
    completionPer1m: 4.4,
    cachedPer1m: 0.26,
  },
  {
    // GLM-5.3 carries the same published per-token rate as GLM-5.2.
    // https://docs.z.ai/guides/overview/pricing
    id: "glm-5.3",
    label: "GLM-5.3",
    brand: "zai",
    promptPer1m: 1.4,
    completionPer1m: 4.4,
    cachedPer1m: 0.26,
  },

  // --- xAI / Grok -----------------------------------------------------------
  // https://docs.x.ai/developers/models (short-context tier; the >=200k-gram
  // prompt-token tier is higher and cannot be represented by this scalar
  // table's single tier - we keep the short-context rates and won't invent a
  // blended average).
  {
    id: "grok-4.5",
    label: "Grok 4.5",
    brand: "xai",
    promptPer1m: 2,
    completionPer1m: 6,
    cachedPer1m: 0.3,
  },
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    brand: "xai",
    promptPer1m: 2,
    completionPer1m: 6,
    cachedPer1m: 0.5,
  },

  // --- Google / Gemini --------------------------------------------------
  // https://ai.google.dev/gemini-api/docs/pricing and
  // https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash (<=200k
  // prompt-token tier; the >200k tier roughly doubles both rates). Like the
  // Sonnet entry above, the 3.7-flash / 3.6-flash rows use the durable
  // post-December-31-2026 standard rates rather than their expiring
  // introductory promotions, so the reference doesn't go stale the day the
  // promo ends.
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    brand: "gemini",
    promptPer1m: 1.5,
    completionPer1m: 7.5,
    cachedPer1m: 0.15,
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    brand: "gemini",
    promptPer1m: 1.5,
    completionPer1m: 7.5,
    cachedPer1m: 0.15,
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    brand: "gemini",
    promptPer1m: 1.5,
    completionPer1m: 9,
    cachedPer1m: 0.15,
  },
  {
    id: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    brand: "gemini",
    promptPer1m: 2,
    completionPer1m: 12,
  },
  {
    // The provider's exact preview id (not the same as the GA "gemini-3.1-pro"
    // entry above); <=200k standard tier.
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (Preview)",
    brand: "gemini",
    promptPer1m: 2,
    completionPer1m: 12,
    cachedPer1m: 0.2,
  },

  // --- Alibaba / Qwen ----------------------------------------------------
  // https://www.alibabacloud.com/help/en/model-studio/model-pricing,
  // https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max
  // (confirmed Aug 3 2026 GA release). List price is used despite the
  // temporary launch discount. Alibaba documents context caching, but this
  // scalar table has no provider-neutral cache-write/read distinction, so we
  // omit cachedPer1m rather than apply an unverified discount.
  {
    id: "qwen3.8-max",
    label: "Qwen3.8-Max",
    brand: "qwen",
    promptPer1m: 2,
    completionPer1m: 6,
  },

  // --- Meta / Muse Spark ---------------------------------------------------
  // https://developer.meta.com/ai/models/muse-spark/
  {
    id: "muse-spark-2.1",
    label: "Muse Spark 2.1",
    brand: "meta",
    promptPer1m: 1.25,
    completionPer1m: 4.25,
    cachedPer1m: 0.15,
  },
  {
    id: "muse-spark-2.1-contributor",
    label: "Muse Spark 2.1 (Contributor)",
    brand: "meta",
    promptPer1m: 0.1,
    completionPer1m: 0.2,
    cachedPer1m: 0.002,
  },

  // --- Moonshot / Kimi ----------------------------------------------------
  // https://platform.kimi.ai/docs/pricing/chat
  {
    id: "kimi-k3",
    label: "Kimi K3",
    brand: "kimi",
    promptPer1m: 3,
    completionPer1m: 15,
    cachedPer1m: 0.3,
  },
  {
    id: "kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    brand: "kimi",
    promptPer1m: 0.95,
    completionPer1m: 4,
    cachedPer1m: 0.19,
  },
  {
    id: "kimi-k2.7-code-highspeed",
    label: "Kimi K2.7 Code (High-Speed)",
    brand: "kimi",
    promptPer1m: 1.9,
    completionPer1m: 8,
    cachedPer1m: 0.38,
  },

  // --- MiniMax -------------------------------------------------------------
  // https://platform.minimax.io/docs/guides/pricing-paygo (current
  // permanently discounted standard rates, not the struck-through pre-
  // discount list prices).
  {
    id: "minimax-m3",
    label: "MiniMax M3",
    brand: "minimax",
    promptPer1m: 0.3,
    completionPer1m: 1.2,
    cachedPer1m: 0.06,
  },
  {
    id: "minimax-m2.7",
    label: "MiniMax M2.7",
    brand: "minimax",
    promptPer1m: 0.3,
    completionPer1m: 1.2,
    cachedPer1m: 0.06,
  },
];

// Full reference list, for a picker UI. Function form (not the raw const)
// matches this app's other catalog-listing seams (e.g. listProviderTemplates,
// listTransformDefs) - a stable read accessor, even though today it's a
// simple array copy.
export function listDefaultModelPricing(): DefaultModelPricing[] {
  return DEFAULT_MODEL_PRICING;
}

const DATE_SUFFIX = /-\d{8}$/;

// Find a default-pricing entry for a gateway alias or upstream model id.
// Matches the exact id first, then tolerates a date-suffix mismatch in either
// direction (same convention as stockAnthropicModel), so e.g. an alias of
// "claude-sonnet-5-20260629" still finds the "claude-sonnet-5" entry.
export function defaultPricingFor(
  idOrAlias: string,
): DefaultModelPricing | undefined {
  const exact = DEFAULT_MODEL_PRICING.find((m) => m.id === idOrAlias);
  if (exact) return exact;
  const base = idOrAlias.replace(DATE_SUFFIX, "");
  return DEFAULT_MODEL_PRICING.find(
    (m) => m.id === base || m.id.replace(DATE_SUFFIX, "") === base,
  );
}
