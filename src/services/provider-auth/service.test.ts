import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from "../../db";
import { createProvider } from "../../repo/providers";
import { getProviderOAuth } from "../../repo/provider-oauth";
import { ProviderAuthCrypto } from "./crypto";
import { ProviderAuthService } from "./service";
import type {
  ProviderAuthCredential,
  ProviderAuthIntegration,
  ProviderAuthPollResult,
} from "./types";

const credential: ProviderAuthCredential = {
  integrationId: "test-auth",
  secrets: { accessToken: "access-secret", refreshToken: "refresh-secret" },
  expiresAt: Date.now() + 3_600_000,
  account: { accountId: "account-1", email: "user@example.com" },
};

function setup(results: ProviderAuthPollResult[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-service-"));
  const db = openDatabase(":memory:");
  let polls = 0;
  const integration: ProviderAuthIntegration = {
    id: "test-auth",
    catalogId: "test-provider",
    async begin() {
      return {
        transaction: { deviceCode: "server-secret" },
        verificationUri: "https://example.com/device",
        verificationUriComplete: "https://example.com/device?code=ABCD",
        userCode: "ABCD",
        expiresAt: Date.now() + 60_000,
        intervalMs: 1,
      };
    },
    async poll() {
      polls++;
      return results.shift() ?? { state: "pending" };
    },
    async refresh(value) {
      return value;
    },
    runtimeCredential(value) {
      return value.secrets.accessToken;
    },
    async test() {
      return { ok: true, status: 200, ms: 1, models: [] };
    },
  };
  const crypto = new ProviderAuthCrypto(db, dir);
  const service = new ProviderAuthService(
    db,
    crypto,
    (catalogId) =>
      catalogId === integration.catalogId ? integration : undefined,
  );
  return {
    db,
    crypto,
    service,
    polls: () => polls,
    close() {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForPoll(view: { nextPollAt?: string }) {
  const delay = Math.max(0, Date.parse(view.nextPollAt ?? "") - Date.now() + 2);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

test(
  "provider auth sessions enforce ownership, cadence, and token-free views",
  async () => {
    const ctx = setup([{ state: "ready", credential }]);
    try {
      const started = await ctx.service.begin("test-provider", "owner-a");
      assert.equal(started.state, "pending");
      assert.equal(started.verification?.userCode, "ABCD");
      assert.equal(JSON.stringify(started).includes("server-secret"), false);
      assert.equal(JSON.stringify(started).includes("access-secret"), false);
      assert.throws(() => ctx.service.get(started.id, "owner-b"));

      const early = await ctx.service.poll(started.id, "owner-a");
      assert.equal(early.state, "pending");
      assert.equal(ctx.polls(), 0);

      await waitForPoll(started);
      const ready = await ctx.service.poll(started.id, "owner-a");
      assert.equal(ready.state, "ready");
      assert.equal(ready.account?.email, "user@example.com");
      assert.equal(JSON.stringify(ready).includes("access-secret"), false);
      assert.deepEqual(await ctx.service.test(started.id, "owner-a"), {
        ok: true,
        status: 200,
        ms: 1,
        models: [],
      });
    } finally {
      ctx.close();
    }
  },
);

test("provider auth sessions adopt once and persist encrypted credentials", async () => {
  const ctx = setup([{ state: "ready", credential }]);
  try {
    const provider = createProvider(ctx.db, {
      id: "managed-provider",
      name: "Managed provider",
      baseUrl: "https://example.com",
      catalogId: "test-provider",
    });
    const started = await ctx.service.begin("test-provider", "owner-a");
    await waitForPoll(started);
    await ctx.service.poll(started.id, "owner-a");

    const view = ctx.service.adoptForNewProvider(
      started.id,
      "owner-a",
      provider.id,
      "test-provider",
    );
    assert.equal(view.account.email, "user@example.com");
    assert.equal(ctx.service.get(started.id, "owner-a").state, "consumed");
    assert.deepEqual(
      getProviderOAuth(ctx.db, ctx.crypto, provider.id)?.credential,
      credential,
    );
    assert.throws(() =>
      ctx.service.adoptForNewProvider(
        started.id,
        "owner-a",
        provider.id,
        "test-provider",
      ),
    );
  } finally {
    ctx.close();
  }
});

test("provider auth cancellation clears a draft and is idempotent", async () => {
  const ctx = setup([]);
  try {
    const started = await ctx.service.begin("test-provider", "owner-a");
    ctx.service.cancel(started.id, "owner-a");
    ctx.service.cancel(started.id, "owner-a");
    assert.equal(ctx.service.get(started.id, "owner-a").state, "cancelled");
    await assert.rejects(() => ctx.service.test(started.id, "owner-a"));
  } finally {
    ctx.close();
  }
});
