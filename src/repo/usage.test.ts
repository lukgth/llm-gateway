import { test } from "node:test";
import assert from "node:assert/strict";
import type { Database as DB } from "better-sqlite3";
import { openDatabase, closeDatabase } from "../db";
import { createApiKey } from "./api-keys";
import { insertRequestLog } from "./request-logs";
import {
  hourlyUsageHistory,
  rebuildUsageFromLogs,
  addUsage,
  usageSummaryToday,
  listUsageToday,
  breakdownForKey,
  fullBreakdownToday,
} from "./usage";

// Insert a log row with an explicit ts (insertRequestLog stamps ts=now, which
// can't distinguish rows within a test) and cached-token control.
function insertAt(
  db: DB,
  ts: string,
  opts: {
    apiKeyId?: string | null;
    model?: string | null;
    providerId?: string | null;
    status?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedTokens?: number | null;
  } = {},
): void {
  insertRequestLog(db, {
    apiKeyId: opts.apiKeyId ?? null,
    apiKeyName: null,
    userId: null,
    model: opts.model ?? "model",
    providerId: opts.providerId ?? "provider",
    providerName: "Provider",
    upstreamModel: "upstream",
    upstreamKeyHash: null,
    upstreamKeyMask: null,
    status: opts.status ?? 200,
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 50,
    cachedTokens: opts.cachedTokens ?? null,
    latencyMs: 10,
    client: null,
    path: "/v1/messages",
    stream: false,
    error: null,
    debugRequest: null,
    debugResponse: null,
    costUsd: null,
  });
  // insertRequestLog always stamps ts=now(); overwrite it with the test's ts
  // so hour-bucket tests can control which bucket a row lands in.
  db.prepare(
    "UPDATE request_logs SET ts = ? WHERE id = (SELECT MAX(id) FROM request_logs)",
  ).run(ts);
}

test("hourlyUsageHistory excludes cached tokens from the realized total", () => {
  const db = openDatabase(":memory:");
  try {
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);
    const hourKey = now.toISOString().slice(0, 13);
    // 1000 input (600 cached) + 200 output -> realized = 400 + 200 = 600.
    insertAt(db, now.toISOString(), {
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 600,
    });
    const history = hourlyUsageHistory(db, 2);
    const bucket = history.find((h) => h.hour === hourKey);
    assert.ok(bucket, `expected an hour bucket for ${hourKey}`);
    assert.equal(bucket!.tokens, 600);
  } finally {
    closeDatabase(db);
  }
});

test("hourlyUsageHistory floors realized input at 0 when cached exceeds input", () => {
  const db = openDatabase(":memory:");
  try {
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);
    const hourKey = now.toISOString().slice(0, 13);
    insertAt(db, now.toISOString(), {
      inputTokens: 50,
      outputTokens: 30,
      cachedTokens: 80,
    });
    const history = hourlyUsageHistory(db, 1);
    const bucket = history.find((h) => h.hour === hourKey);
    assert.ok(bucket);
    // realized input = max(0, 50 - 80) = 0; total = 0 + 30 = 30.
    assert.equal(bucket!.tokens, 30);
  } finally {
    closeDatabase(db);
  }
});

test("rebuildUsageFromLogs recomputes usage + usage_breakdown excluding cached tokens", () => {
  const db = openDatabase(":memory:");
  try {
    const today = new Date().toISOString().slice(0, 10);
    createApiKey(db, { id: "key1", name: "Key 1" }, "gw-test-secret");
    // Two successful requests for the same key/model/provider, one with a
    // large cache hit. Naive input+output would total 1000+200+100+50=1350;
    // realized (cache-excluded) totals to (1000-600+200)+(100+50)=600+150=750.
    insertAt(db, `${today}T10:00:00.000Z`, {
      apiKeyId: "key1",
      model: "claude-opus",
      providerId: "anthropic-prod",
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 600,
    });
    insertAt(db, `${today}T11:00:00.000Z`, {
      apiKeyId: "key1",
      model: "claude-opus",
      providerId: "anthropic-prod",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: null,
    });
    // A failed (non-2xx) request must not contribute at all.
    insertAt(db, `${today}T12:00:00.000Z`, {
      apiKeyId: "key1",
      model: "claude-opus",
      providerId: "anthropic-prod",
      status: 500,
      inputTokens: 9999,
      outputTokens: 9999,
      cachedTokens: 7000,
    });

    // Seed the live counters with a wrong value to prove the rebuild
    // actually overwrites them rather than just reading pre-existing state.
    addUsage(db, "key1", 999_999);

    const result = rebuildUsageFromLogs(db, today);
    assert.equal(result.usageRows, 1);
    assert.equal(result.breakdownRows, 1);
    assert.equal(result.tokens, 750);

    const usageRow = db
      .prepare("SELECT tokens FROM usage WHERE api_key_id = ? AND day = ?")
      .get("key1", today) as { tokens: number };
    assert.equal(usageRow.tokens, 750);

    const bdRow = db
      .prepare(
        "SELECT tokens, requests FROM usage_breakdown WHERE api_key_id = ? AND day = ? AND model = ?",
      )
      .get("key1", today, "claude-opus") as {
      tokens: number;
      requests: number;
    };
    assert.equal(bdRow.tokens, 750);
    assert.equal(bdRow.requests, 2); // only the two 2xx rows

    assert.deepEqual(usageSummaryToday(db), {
      total: 750,
      input: 1100,
      cached: 600,
    });
    assert.equal(
      listUsageToday(db).find((row) => row.apiKeyId === "key1")?.cached,
      600,
    );
    assert.equal(
      breakdownForKey(db, "key1", today).find(
        (row) =>
          row.model === "claude-opus" && row.providerId === "anthropic-prod",
      )?.cached,
      600,
    );
    assert.equal(
      fullBreakdownToday(db, today).find(
        (row) =>
          row.apiKeyId === "key1" &&
          row.model === "claude-opus" &&
          row.providerId === "anthropic-prod",
      )?.cached,
      600,
    );
  } finally {
    closeDatabase(db);
  }
});
