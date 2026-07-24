// Generic bounded-concurrency worker pool. Every caller in this codebase
// used to hand-roll a `queue.shift()` loop over N async workers (see the
// frontend's provider-key-manager.tsx testAll for the original pattern) —
// this is the shared, order-preserving version for backend use.

export interface ConcurrencyResult<T> {
  index: number;
  item: T;
  ok: boolean;
  value?: unknown;
  error?: unknown;
}

/**
 * Runs `task` over every item in `items` with at most `concurrency` in
 * flight at once. Results are returned in the SAME order as `items`
 * regardless of completion order. A single item's rejection does not abort
 * the pool — it's captured as `{ ok: false, error }` in that item's slot.
 *
 * `onSettled` (optional) fires as each item finishes, in completion order —
 * use it to stream progress before the whole pool resolves.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
  onSettled?: (result: ConcurrencyResult<T> & { value?: R }) => void,
): Promise<Array<ConcurrencyResult<T> & { value?: R }>> {
  const results: Array<ConcurrencyResult<T> & { value?: R }> = new Array(
    items.length,
  );
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      let result: ConcurrencyResult<T> & { value?: R };
      try {
        const value = await task(item, index);
        result = { index, item, ok: true, value };
      } catch (error) {
        result = { index, item, ok: false, error };
      }
      results[index] = result;
      onSettled?.(result);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
