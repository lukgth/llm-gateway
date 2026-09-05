import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "node:http";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from "../../db";
import { createProvider, getProvider } from "../../repo/providers";
import { listProviderKeys } from "../../repo/provider-keys";
import { createProviderOAuth } from "../../repo/provider-oauth";
import { upsertUnifiedUsage } from "../../repo/provider-key-usage";
import { ProviderAuthCrypto } from "../../services/provider-auth/crypto";
import { ProviderCredentialService } from "../../services/provider-credentials";
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
    const report = await buildUsageReport(
      getProvider(db, "hanging")!,
      db,
      undefined,
      20,
    );
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

// Codex-style managed-auth providers hold their credentials as OAuth accounts
// (provider_oauth_credentials), NOT provider_keys rows - the report used to
// read only the latter, so Codex never appeared on the usage dashboard. The
// report must resolve each account's live token through the shared
// ProviderCredentialService (same path as live requests) and attribute
// health/last-used by the same cred hash the engine stamps.
test("openai-codex report lists OAuth accounts and queries real windows", async () => {
  // Local upstream serving /backend-api/wham/usage in the same shape codex-lb
  // parses (rate_limit.primary_window / secondary_window).
  const seen: { auth?: string; accountId?: string | undefined } = {};
  const server = http.createServer((req, res) => {
    if (req.url?.includes("/wham/usage")) {
      seen.auth = req.headers.authorization;
      seen.accountId = req.headers["chatgpt-account-id"] as string | undefined;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 42.5,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
              limit_window_seconds: 5 * 3600,
            },
            secondary_window: { used_percent: 7.5 },
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-report-codex-"));
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "codex-up",
      name: "OpenAI Codex",
      baseUrl: `http://127.0.0.1:${port}`,
      basePath: "/backend-api/codex",
      catalogId: "openai-codex",
    });
    const crypto = new ProviderAuthCrypto(db, dir);
    createProviderOAuth(db, crypto, "codex-up", {
      integrationId: "codex",
      secrets: { accessToken: "codex-access-token" },
      expiresAt: Date.now() + 60 * 60_000,
      account: { accountId: "acct-e2e", email: "e2e@example.com" },
    });

    const report = await buildUsageReport(
      getProvider(db, "codex-up")!,
      db,
      new ProviderCredentialService(db, crypto),
    );
    assert.equal(report.supported, true);
    assert.equal(report.keys.length, 1);
    const key = report.keys[0];
    assert.equal(key.enabled, true);
    assert.equal(key.keyMask, "e2e@example.com");
    assert.equal(key.windows.length, 2);
    assert.equal(key.windows[0].used, 42.5);
    assert.equal(key.windows[0].label, "Session");
    assert.ok(key.windows[0].resetsAt);
    assert.equal(key.windows[1].used, 7.5);
    // The adapter sent the resolved access token + account id, NOT the
    // `oauth:<id>` health key, and the Codex identity headers rode along.
    assert.equal(seen.auth, "Bearer codex-access-token");
    assert.equal(seen.accountId, "acct-e2e");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
