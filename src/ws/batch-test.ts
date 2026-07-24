// Batch key testing — the async job body behind the "batch-test" WS
// message. Kept separate from the hub so the concurrency/validation logic
// is testable without a live socket (see batch-test.test.ts).

import type { Database as DB } from "better-sqlite3";
import { getProvider } from "../repo/providers";
import { getProviderKey } from "../repo/provider-keys";
import { testSavedProvider } from "../admin/routes/provider-probe";
import { runWithConcurrency } from "../utils/concurrency";
import type { TestProviderResult } from "../providers/base/types";

// Bandwidth/abuse guards — mirrors the frontend's pre-existing hand-rolled
// worker-pool constant (provider-key-manager.tsx's old testAll), now
// enforced server-side since this is the actual fan-out point.
export const MAX_BATCH_KEYS = 200;
export const BATCH_CONCURRENCY = 5;

export interface BatchTestProgress {
  index: number;
  keyId: string;
  result: TestProviderResult;
}

export interface BatchTestDone {
  total: number;
  ok: number;
}

export interface BatchTestCallbacks {
  onProgress: (progress: BatchTestProgress) => void;
  onDone: (done: BatchTestDone) => void;
  /** Polled between dispatches — a closed socket stops new tests early. */
  isCancelled: () => boolean;
}

/**
 * Validates the request and, if valid, runs the batch and returns null.
 * Returns an error message instead of running anything if the provider or
 * any keyId doesn't resolve, keyIds is empty, or the batch exceeds
 * MAX_BATCH_KEYS.
 */
export async function runBatchTest(
  db: DB,
  input: { providerId: string; keyIds: string[] },
  callbacks: BatchTestCallbacks,
): Promise<string | null> {
  const { providerId, keyIds } = input;

  if (keyIds.length === 0) return "keyIds must be a non-empty array";
  if (keyIds.length > MAX_BATCH_KEYS)
    return `batch too large: ${keyIds.length} keys (max ${MAX_BATCH_KEYS})`;

  const provider = getProvider(db, providerId);
  if (!provider) return `provider not found: ${providerId}`;

  const keys = keyIds.map((keyId) => ({
    keyId,
    key: getProviderKey(db, keyId),
  }));
  const missing = keys.find((k) => !k.key || k.key.providerId !== providerId);
  if (missing) return `key not found on this provider: ${missing.keyId}`;

  let ok = 0;
  await runWithConcurrency(keys, BATCH_CONCURRENCY, async ({ key }, index) => {
    if (callbacks.isCancelled()) return null;
    const result = await testSavedProvider(provider, db, key!.credential);
    if (result.ok) ok++;
    callbacks.onProgress({ index, keyId: keys[index].keyId, result });
    return result;
  });

  callbacks.onDone({ total: keyIds.length, ok });
  return null;
}
