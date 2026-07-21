import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { insertRequestLog, listRequestLogs } from "./request-logs";

const base = {
  apiKeyId: null,
  apiKeyName: null,
  userId: null,
  model: "model",
  providerId: "provider",
  providerName: "Provider",
  upstreamModel: "upstream",
  status: 200,
  inputTokens: 1,
  outputTokens: 2,
  cachedTokens: null,
  latencyMs: 10,
  client: null,
  path: "/v1/messages",
  stream: false,
  error: null,
  debugRequest: null,
  debugResponse: null,
};

test("request logs round-trip immutable upstream key mask without exposing hash", () => {
  const db = openDatabase(":memory:");
  try {
    insertRequestLog(db, {
      ...base,
      upstreamKeyHash: "secret-hash",
      upstreamKeyMask: "sk-ant…1234",
    });
    const [log] = listRequestLogs(db);
    assert.equal(log.upstreamKeyMask, "sk-ant…1234");
    assert.equal("upstreamKeyHash" in log, false);
    const stored = db
      .prepare(
        "SELECT upstream_key_hash, upstream_key_mask FROM request_logs WHERE id = ?",
      )
      .get(log.id) as Record<string, unknown>;
    assert.equal(stored.upstream_key_hash, "secret-hash");
    assert.equal(stored.upstream_key_mask, "sk-ant…1234");
  } finally {
    closeDatabase(db);
  }
});

test("request logs preserve null attribution for keyless/pre-attempt rows", () => {
  const db = openDatabase(":memory:");
  try {
    insertRequestLog(db, {
      ...base,
      upstreamKeyHash: null,
      upstreamKeyMask: null,
    });
    const [log] = listRequestLogs(db);
    assert.equal(log.upstreamKeyMask, null);
  } finally {
    closeDatabase(db);
  }
});
