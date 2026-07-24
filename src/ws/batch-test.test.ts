import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import type { AddressInfo } from "net";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { listProviderKeys } from "../repo/provider-keys";
import { runBatchTest, MAX_BATCH_KEYS } from "./batch-test";
import type { BatchTestProgress, BatchTestDone } from "./batch-test";

function neverCancelled() {
  return false;
}

test("runBatchTest: unknown provider returns an error, runs nothing", async () => {
  const db = openDatabase(":memory:");
  try {
    const progress: BatchTestProgress[] = [];
    const error = await runBatchTest(
      db,
      { providerId: "does-not-exist", keyIds: ["a"] },
      {
        onProgress: (p) => progress.push(p),
        onDone: () => assert.fail("onDone should not fire"),
        isCancelled: neverCancelled,
      },
    );
    assert.match(error!, /provider not found/);
    assert.equal(progress.length, 0);
  } finally {
    closeDatabase(db);
  }
});

test("runBatchTest: unknown keyId returns an error, runs nothing", async () => {
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: "http://127.0.0.1:1",
      apiKeys: ["k-1"],
      catalogId: "openai",
      authScheme: "bearer",
    });
    const error = await runBatchTest(
      db,
      { providerId: "up", keyIds: ["nonexistent-key-id"] },
      {
        onProgress: () => assert.fail("onProgress should not fire"),
        onDone: () => assert.fail("onDone should not fire"),
        isCancelled: neverCancelled,
      },
    );
    assert.match(error!, /key not found/);
  } finally {
    closeDatabase(db);
  }
});

test("runBatchTest: a keyId belonging to a different provider is rejected", async () => {
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up-a",
      name: "up-a",
      baseUrl: "http://127.0.0.1:1",
      apiKeys: ["k-a"],
      catalogId: "openai",
      authScheme: "bearer",
    });
    createProvider(db, {
      id: "up-b",
      name: "up-b",
      baseUrl: "http://127.0.0.1:1",
      apiKeys: ["k-b"],
      catalogId: "openai",
      authScheme: "bearer",
    });
    const bKeyId = listProviderKeys(db, "up-b")[0].id;
    const error = await runBatchTest(
      db,
      { providerId: "up-a", keyIds: [bKeyId] },
      {
        onProgress: () => assert.fail("onProgress should not fire"),
        onDone: () => assert.fail("onDone should not fire"),
        isCancelled: neverCancelled,
      },
    );
    assert.match(error!, /key not found/);
  } finally {
    closeDatabase(db);
  }
});

test("runBatchTest: empty keyIds is rejected", async () => {
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: "http://127.0.0.1:1",
      apiKeys: ["k-1"],
      catalogId: "openai",
      authScheme: "bearer",
    });
    const error = await runBatchTest(
      db,
      { providerId: "up", keyIds: [] },
      {
        onProgress: () => assert.fail("onProgress should not fire"),
        onDone: () => assert.fail("onDone should not fire"),
        isCancelled: neverCancelled,
      },
    );
    assert.match(error!, /non-empty/);
  } finally {
    closeDatabase(db);
  }
});

test("runBatchTest: rejects a batch larger than MAX_BATCH_KEYS", async () => {
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: "http://127.0.0.1:1",
      apiKeys: ["k-1"],
      catalogId: "openai",
      authScheme: "bearer",
    });
    const tooMany = Array.from(
      { length: MAX_BATCH_KEYS + 1 },
      (_, i) => `k${i}`,
    );
    const error = await runBatchTest(
      db,
      { providerId: "up", keyIds: tooMany },
      {
        onProgress: () => assert.fail("onProgress should not fire"),
        onDone: () => assert.fail("onDone should not fire"),
        isCancelled: neverCancelled,
      },
    );
    assert.match(error!, /batch too large/);
  } finally {
    closeDatabase(db);
  }
});

test("runBatchTest: happy path streams per-key progress with correct index/keyId, then a single done", async () => {
  // A real local upstream that answers ok/fail based on which key it sees,
  // so we can assert the progress events' `ok` correctness end-to-end.
  const server = http.createServer((req, res) => {
    const auth = req.headers["authorization"] as string;
    if (auth === "Bearer k-good-1" || auth === "Bearer k-good-2") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad key" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k-good-1", "k-bad", "k-good-2"],
      catalogId: "openai",
      authScheme: "bearer",
    });
    const keys = listProviderKeys(db, "up");
    const byCred = Object.fromEntries(keys.map((k) => [k.credential, k.id]));
    const keyIds = [byCred["k-good-1"], byCred["k-bad"], byCred["k-good-2"]];

    const progress: BatchTestProgress[] = [];
    let done: BatchTestDone | undefined;
    const error = await runBatchTest(
      db,
      { providerId: "up", keyIds },
      {
        onProgress: (p) => progress.push(p),
        onDone: (d) => (done = d),
        isCancelled: neverCancelled,
      },
    );

    assert.equal(error, null);
    assert.equal(progress.length, 3);
    // Every progress event's index must point back to the correct keyId in
    // the ORIGINAL request order, regardless of completion order.
    for (const p of progress) {
      assert.equal(keyIds[p.index], p.keyId);
    }
    const byIndex = new Map(progress.map((p) => [p.index, p]));
    assert.equal(byIndex.get(0)!.result.ok, true);
    assert.equal(byIndex.get(1)!.result.ok, false);
    assert.equal(byIndex.get(2)!.result.ok, true);

    assert.deepEqual(done, { total: 3, ok: 2 });
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("runBatchTest: cancellation stops dispatching new tests early", async () => {
  let dispatched = 0;
  const server = http.createServer((_req, res) => {
    dispatched++;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    }, 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: Array.from({ length: 10 }, (_, i) => `k-${i}`),
      catalogId: "openai",
      authScheme: "bearer",
      // Concurrency is fixed at 5 inside runBatchTest, so only the first
      // wave (up to 5) should dispatch before we flip cancelled — proving
      // isCancelled() is actually polled between dispatches, not just at
      // the top of the whole run.
    });
    const keyIds = listProviderKeys(db, "up").map((k) => k.id);

    let cancelled = false;
    setTimeout(() => (cancelled = true), 5);

    const progress: BatchTestProgress[] = [];
    await runBatchTest(
      db,
      { providerId: "up", keyIds },
      {
        onProgress: (p) => progress.push(p),
        onDone: () => {},
        isCancelled: () => cancelled,
      },
    );

    assert.ok(
      dispatched < keyIds.length,
      `expected cancellation to stop early, but all ${keyIds.length} were dispatched`,
    );
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});
