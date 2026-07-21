import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../../db";
import { createProvider, getProvider } from "../../repo/providers";
import { listProviderKeys } from "../../repo/provider-keys";
import { upsertUnifiedUsage } from "../../repo/provider-key-usage";
import { buildUsageReport } from "./usage-report";

test("Claude Code report hides untried and disabled keys", async () => {
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "cc",
      name: "Claude Code",
      baseUrl: "https://api.anthropic.com",
      catalogId: "claude-code",
      apiKeys: ["sk-ant-tried", "sk-ant-untried", "sk-ant-disabled"],
    });
    const keys = listProviderKeys(db, "cc");
    db.prepare("UPDATE provider_keys SET enabled = 0 WHERE id = ?").run(
      keys[2].id,
    );
    upsertUnifiedUsage(
      db,
      "cc",
      keys[0].credHash,
      {
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.33",
      },
      200,
    );

    const report = await buildUsageReport(getProvider(db, "cc")!, db);
    assert.equal(report.supported, true);
    assert.equal(report.keys.length, 1);
    assert.equal(report.keys[0].unavailable, undefined);
    assert.equal(report.keys[0].enabled, true);
    assert.equal(report.keys[0].windows[0].used, 33);
  } finally {
    closeDatabase(db);
  }
});
