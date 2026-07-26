// Import upstream models into a provider's imported-model catalog.
//
// Importing NEVER creates exposed models. Each selected upstream id becomes a
// `provider_models` row (idempotent by (provider, upstream_id)). Exposed models
// are authored separately as chains that reference these imported entries.

import { api } from "@/lib/api";
import type { UpstreamModel } from "@/lib/types";

export interface ImportResult {
  created: number;
  skipped: number;
}

// Import the given upstream models into a provider's catalog, carrying each
// model's discovered metadata (display name, context window, max output,
// capabilities) so wizard-time imports are as rich as the standalone importer.
export async function importModelsForProvider(
  providerId: string,
  models: Iterable<UpstreamModel>,
): Promise<ImportResult> {
  const list = [...models];
  const result: ImportResult = { created: 0, skipped: 0 };
  if (list.length === 0) return result;

  const existing = await api.listProviderModels(providerId);
  const have = new Set(existing.map((m) => m.upstreamId));

  const fresh = list.filter((m) => !have.has(m.id));
  result.skipped = list.length - fresh.length;
  if (fresh.length === 0) return result;

  // One request, one transaction - not one round-trip per model.
  const res = await api.batchProviderModels(providerId, {
    create: fresh.map((m) => ({
      upstreamId: m.id,
      displayName: m.displayName ?? null,
      contextWindow: m.contextWindow ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
      capabilities: m.capabilities ?? null,
    })),
  });
  result.created = res.created + res.updated;
  result.skipped += res.errors.length;
  return result;
}
