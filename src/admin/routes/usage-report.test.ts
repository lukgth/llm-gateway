import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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

// A hanging upstream (provider reachable at TCP level but never responding - the
// blackholed-route case that used to stall the whole dashboard past the proxy's
// read timeout into a 504) must resolve within the report budget to an
// unavailable key instead of blocking for the full interactive 30s probe timeout.
test("an unreachable/hanging upstream degrades to unavailable within the report budget", async () => {
  const db = openDatabase(":memory:");
  const server = http.createServer(() => {
    // Accept the connection and never reply: the probe's TCP handshake
    // succeeds, then it hangs waiting for a response - exactly what a route
    // that silently drops packets does. No fast error, no response.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    createProvider(db, {
      id: "hanging",
      name: "Hanging Provider",
      baseUrl: `http://127.0.0.1:${port}`,
      catalogId: "newapi",
      apiKeys: ["sk-test-1"],
    });

    // Tiny budget: prove the cap resolves the report fast regardless of the
    // 30s interactive probe the abandoned query would otherwise sit on.
    const started = Date.now();
    const report = await buildUsageReport(getProvider(db, "hanging")!, db, 20);
    const elapsed = Date.now() - started;

    assert.equal(report.supported, true);
    assert.equal(report.keys.length, 1);
    assert.equal(report.keys[0].enabled, true);
    assert.equal(report.keys[0].unavailable, true);
    assert.match(report.keys[0].message ?? "", /timed out/);
    assert.ok(
      elapsed < 1_000,
      `expected report to resolve within ~1s, took ${elapsed}ms`,
    );
  } finally {
    // Destroy the held-open socket so the abandoned probe settles and no
    // dangling 30s timer/socket keeps the test process alive.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
  }
});
