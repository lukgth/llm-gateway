// Model pricing repository. One row per exposed-model alias, carrying
// per-million-token rates for prompt, completion, cached (read), and
// cache-write tokens. The write rate is optional per model and defaults to
// the cached rate, so reads and writes cost the same unless the operator
// sets a distinct write price.

import type { Database as DB } from "better-sqlite3";

export interface ModelPricing {
  alias: string;
  promptPer1m: number | null;
  completionPer1m: number | null;
  cachedPer1m: number | null;
  cacheWritePer1m: number | null;
  updatedAt: string;
}

interface PricingRow {
  alias: string;
  prompt_per_1m: number | null;
  completion_per_1m: number | null;
  cached_per_1m: number | null;
  cache_write_per_1m: number | null;
  updated_at: string;
}

function mapPricing(r: PricingRow): ModelPricing {
  return {
    alias: r.alias,
    promptPer1m: r.prompt_per_1m,
    completionPer1m: r.completion_per_1m,
    cachedPer1m: r.cached_per_1m,
    cacheWritePer1m: r.cache_write_per_1m,
    updatedAt: r.updated_at,
  };
}

export function getPricingByAlias(db: DB, alias: string): ModelPricing | null {
  const row = db
    .prepare("SELECT * FROM model_pricing WHERE alias = ?")
    .get(alias) as PricingRow | undefined;
  return row ? mapPricing(row) : null;
}

export function upsertPricing(
  db: DB,
  p: Omit<ModelPricing, "updatedAt">,
): ModelPricing {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO model_pricing (alias, prompt_per_1m, completion_per_1m, cached_per_1m, cache_write_per_1m, updated_at)
     VALUES (@alias, @promptPer1m, @completionPer1m, @cachedPer1m, @cacheWritePer1m, @now)
     ON CONFLICT(alias) DO UPDATE SET
       prompt_per_1m = @promptPer1m,
       completion_per_1m = @completionPer1m,
       cached_per_1m = @cachedPer1m,
       cache_write_per_1m = @cacheWritePer1m,
       updated_at = @now`,
  ).run({
    alias: p.alias,
    promptPer1m: p.promptPer1m,
    completionPer1m: p.completionPer1m,
    cachedPer1m: p.cachedPer1m,
    cacheWritePer1m: p.cacheWritePer1m,
    now,
  });
  return { ...p, updatedAt: now };
}

export function deletePricing(db: DB, alias: string): boolean {
  const r = db.prepare("DELETE FROM model_pricing WHERE alias = ?").run(alias);
  return r.changes > 0;
}

// Compute per-request dollar cost from actual tokens. Cached (read) tokens are
// billed at cachedPer1m when set, otherwise at promptPer1m (OpenAI
// convention). Cache-write tokens use cacheWritePer1m when set, otherwise
// fall back to the cached rate - so reads and writes cost the same unless a
// distinct write price is configured. Any missing required rate makes the
// whole row's cost null (no partial estimates).
export function computeCostUsd(
  pricing: ModelPricing | null | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
  cachedTokens: number | null,
  cacheWriteTokens: number | null = null,
): number | null {
  if (!pricing) return null;
  const { promptPer1m, completionPer1m, cachedPer1m, cacheWritePer1m } =
    pricing;
  if (promptPer1m == null || completionPer1m == null) return null;

  const cachedRate = cachedPer1m ?? promptPer1m;
  const writeRate = cacheWritePer1m ?? cachedRate;
  const cached = cachedTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  const inputBillable = Math.max(0, (inputTokens ?? 0) - cached - cacheWrite);
  const output = outputTokens ?? 0;

  return (
    (inputBillable * promptPer1m +
      cached * cachedRate +
      cacheWrite * writeRate +
      output * completionPer1m) /
    1_000_000
  );
}
