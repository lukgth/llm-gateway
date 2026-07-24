import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "./concurrency";

test("runWithConcurrency: never exceeds the concurrency cap", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  await runWithConcurrency(items, 3, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return item * 2;
  });

  assert.ok(maxActive <= 3, `expected max 3 concurrent, saw ${maxActive}`);
});

test("runWithConcurrency: preserves item order despite out-of-order completion", async () => {
  // Item 0 takes longest, item 4 finishes first — results must still land
  // back in index order, matching the "returned with an index" requirement.
  const delays = [30, 5, 20, 10, 1];
  const results = await runWithConcurrency(delays, 5, async (delay, i) => {
    await new Promise((r) => setTimeout(r, delay));
    return i;
  });

  assert.deepEqual(
    results.map((r) => r.value),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    results.map((r) => r.index),
    [0, 1, 2, 3, 4],
  );
});

test("runWithConcurrency: a single item's rejection doesn't abort the pool", async () => {
  const items = [1, 2, 3, 4];
  const results = await runWithConcurrency(items, 2, async (item) => {
    if (item === 2) throw new Error("boom");
    return item * 10;
  });

  assert.equal(results.length, 4);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].value, 10);
  assert.equal(results[1].ok, false);
  assert.equal((results[1].error as Error).message, "boom");
  assert.equal(results[2].ok, true);
  assert.equal(results[2].value, 30);
  assert.equal(results[3].ok, true);
  assert.equal(results[3].value, 40);
});

test("runWithConcurrency: onSettled fires once per item as results land", async () => {
  const seen: number[] = [];
  const items = [1, 2, 3];
  await runWithConcurrency(
    items,
    3,
    async (item) => item,
    (result) => seen.push(result.index),
  );
  assert.equal(seen.length, 3);
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

test("runWithConcurrency: empty input resolves immediately with an empty array", async () => {
  const results = await runWithConcurrency([], 5, async () => 1);
  assert.deepEqual(results, []);
});
