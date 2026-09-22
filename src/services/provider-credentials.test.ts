import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import {
  createProviderOAuth,
  getProviderOAuth,
  getProviderOAuthView,
  markProviderOAuthReauthRequired,
  replaceProviderOAuth,
  setProviderOAuthEnabled,
} from "../repo/provider-oauth";
import { ProviderAuthCrypto } from "./provider-auth/crypto";
import type {
  ProviderAuthCredential,
  ProviderAuthIntegration,
} from "./provider-auth/types";
import { ProviderCredentialService } from "./provider-credentials";

function setup(
  expiresAt: number,
  overrides: Partial<ProviderAuthIntegration> = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-credentials-"));
  const db = openDatabase(":memory:");
  const provider = createProvider(db, {
    id: "clinefree-provider",
    name: "Cline Free",
    baseUrl: "https://api.cline.bot",
    catalogId: "clinefree",
  });
  const crypto = new ProviderAuthCrypto(db, dir);
  createProviderOAuth(db, crypto, provider.id, {
    integrationId: "clinefree",
    secrets: { accessToken: "access-token", refreshToken: "refresh-token" },
    expiresAt,
    account: { accountId: "account-1", email: "user@example.com" },
  });
  const integration: ProviderAuthIntegration = {
    id: "clinefree",
    catalogId: "clinefree",
    async begin() {
      throw new Error("not used");
    },
    async poll() {
      throw new Error("not used");
    },
    async refresh(value) {
      return {
        ...value,
        secrets: { ...value.secrets, accessToken: "refreshed-token" },
        expiresAt: Date.now() + 60 * 60_000,
      };
    },
    runtimeCredential(value) {
      return `workos:${value.secrets.accessToken}`;
    },
    async test() {
      return { ok: true, status: 200, ms: 1, models: [] };
    },
    ...overrides,
  };
  return {
    db,
    provider,
    crypto,
    integration,
    service: new ProviderCredentialService(
      db,
      crypto,
      (id) => (id === integration.id ? integration : undefined),
    ),
    close() {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("managed credential resolution keeps a stable non-secret health identity", async () => {
  const ctx = setup(Date.now() + 60 * 60_000);
  try {
    const stored = getProviderOAuth(ctx.db, ctx.crypto, ctx.provider.id)!;
    const handle = await ctx.service.resolveManaged(ctx.provider.id);
    assert.equal(handle?.source, "oauth");
    assert.equal(handle?.healthKey, `oauth:${stored.id}`);
    assert.equal(handle?.value, "workos:access-token");
    assert.equal(handle?.mask, "user@example.com");
    assert.equal(handle?.healthKey.includes("access-token"), false);
  } finally {
    ctx.close();
  }
});

test("expired managed credentials become reconnect-required after refresh failure", async () => {
  const ctx = setup(Date.now() - 1, {
    async refresh() {
      throw new Error("network unavailable");
    },
  });
  try {
    await assert.rejects(
      () => ctx.service.resolveManaged(ctx.provider.id),
      /network unavailable/,
    );
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id)?.status,
      "reauth_required",
    );
  } finally {
    ctx.close();
  }
});

test("disabled managed credentials are rejected before decryption or refresh", async () => {
  let refreshes = 0;
  const ctx = setup(Date.now() - 1, {
    async refresh(value) {
      refreshes++;
      return value;
    },
  });
  try {
    const account = getProviderOAuthView(ctx.db, ctx.provider.id)!;
    setProviderOAuthEnabled(ctx.db, ctx.provider.id, account.id, false);
    await assert.rejects(
      () => ctx.service.resolveManaged(ctx.provider.id, account.id),
      /authentication is disabled/,
    );
    assert.equal(refreshes, 0);
    assert.equal((await ctx.service.testManaged(ctx.provider.id)).status, null);
    assert.equal(refreshes, 0);

    setProviderOAuthEnabled(ctx.db, ctx.provider.id, account.id, true);
    assert.equal(
      (await ctx.service.resolveManaged(ctx.provider.id))?.value,
      "workos:access-token",
    );
    assert.equal(refreshes, 1);
  } finally {
    ctx.close();
  }
});

test("authentication checks refresh once and mark persistent rejection", async () => {
  let refreshes = 0;
  let tests = 0;
  const ctx = setup(Date.now() + 60 * 60_000, {
    async refresh(value) {
      refreshes++;
      return {
        ...value,
        secrets: { ...value.secrets, accessToken: `refreshed-${refreshes}` },
        expiresAt: Date.now() + 60 * 60_000,
      };
    },
    async test(_credential: ProviderAuthCredential) {
      tests++;
      return {
        ok: false,
        status: 401,
        ms: 1,
        error: "invalid token",
        models: [],
      };
    },
  });
  try {
    const result = await ctx.service.testManaged(ctx.provider.id);
    assert.equal(result.status, 401);
    assert.equal(tests, 2);
    assert.equal(refreshes, 1);
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id)?.status,
      "reauth_required",
    );
  } finally {
    ctx.close();
  }
});

test("authentication checks keep transient failures active", async () => {
  const ctx = setup(Date.now() + 60 * 60_000, {
    async test() {
      return {
        ok: false,
        status: 503,
        ms: 1,
        error: "unavailable",
        models: [],
      };
    },
  });
  try {
    assert.equal((await ctx.service.testManaged(ctx.provider.id)).status, 503);
    assert.equal(getProviderOAuthView(ctx.db, ctx.provider.id)?.status, "active");
  } finally {
    ctx.close();
  }
});

test("authentication checks keep refresh transport failures active", async () => {
  let tests = 0;
  const ctx = setup(Date.now() + 60 * 60_000, {
    async refresh() {
      throw new Error("refresh unavailable");
    },
    async test() {
      tests++;
      return {
        ok: false,
        status: 401,
        ms: 1,
        error: "invalid token",
        models: [],
      };
    },
  });
  try {
    await assert.rejects(
      () => ctx.service.testManaged(ctx.provider.id),
      /refresh unavailable/,
    );
    assert.equal(tests, 1);
    assert.equal(getProviderOAuthView(ctx.db, ctx.provider.id)?.status, "active");
  } finally {
    ctx.close();
  }
});

test("authentication checks proactively refresh near-expiry credentials", async () => {
  let refreshes = 0;
  let testedToken = "";
  const ctx = setup(Date.now() + 60_000, {
    async refresh(value) {
      refreshes++;
      return {
        ...value,
        secrets: { ...value.secrets, accessToken: "fresh-access-token" },
        expiresAt: Date.now() + 60 * 60_000,
      };
    },
    async test(value) {
      testedToken = value.secrets.accessToken;
      return { ok: true, status: 200, ms: 1, models: [] };
    },
  });
  try {
    assert.equal((await ctx.service.testManaged(ctx.provider.id)).ok, true);
    assert.equal(refreshes, 1);
    assert.equal(testedToken, "fresh-access-token");
  } finally {
    ctx.close();
  }
});

test("expired credential without a refresh token is marked reauth_required without a refresh call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-credentials-"));
  const db = openDatabase(":memory:");
  try {
    const provider = createProvider(db, {
      id: "codex-provider",
      name: "OpenAI Codex",
      baseUrl: "https://chatgpt.com",
      catalogId: "openai-codex",
    });
    const crypto = new ProviderAuthCrypto(db, dir);
    createProviderOAuth(db, crypto, provider.id, {
      integrationId: "codex",
      // Cookie-derived session: no refreshToken at all.
      secrets: { accessToken: "cookie-access", idToken: "cookie-id" },
      expiresAt: Date.now() - 1,
      account: { accountId: "acct-1", email: "user@example.com" },
    });
    let refreshes = 0;
    const integration: ProviderAuthIntegration = {
      id: "codex",
      catalogId: "openai-codex",
      async begin() {
        throw new Error("not used");
      },
      async poll() {
        throw new Error("not used");
      },
      async refresh(value) {
        refreshes++;
        return value;
      },
      runtimeCredential(value) {
        return value.secrets.accessToken;
      },
      async test() {
        return { ok: true, status: 200, ms: 1, models: [] };
      },
    };
    const service = new ProviderCredentialService(
      db,
      crypto,
      (id) => (id === integration.id ? integration : undefined),
    );
    await assert.rejects(
      () => service.resolveManaged(provider.id),
      /re-import the Codex session/,
    );
    assert.equal(refreshes, 0);
    assert.equal(
      getProviderOAuthView(db, provider.id)?.status,
      "reauth_required",
    );
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reauth_required rows revive from their stored refresh token", async () => {
  const ctx = setup(Date.now() + 60 * 60_000);
  try {
    const view = getProviderOAuthView(ctx.db, ctx.provider.id)!;
    markProviderOAuthReauthRequired(ctx.db, ctx.provider.id, view.id);
    // Selectable while reauth_required: the engine must still see it.
    assert.deepEqual(ctx.service.candidates(ctx.provider.id), [
      `oauth:${view.id}`,
    ]);
    const handle = await ctx.service.resolveManaged(ctx.provider.id);
    assert.equal(handle?.value, "workos:refreshed-token");
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id)?.status,
      "active",
    );
  } finally {
    ctx.close();
  }
});

test("reauth_required rows without a refresh token still demand reconnection", async () => {
  const ctx = setup(Date.now() + 60 * 60_000);
  try {
    const view = getProviderOAuthView(ctx.db, ctx.provider.id)!;
    // Cookie-derived credential: nothing to refresh with.
    replaceProviderOAuth(ctx.db, ctx.crypto, ctx.provider.id, view.id, {
      integrationId: "clinefree",
      secrets: { accessToken: "cookie-access", idToken: "cookie-id" },
      expiresAt: Date.now() + 60 * 60_000,
      account: { accountId: "account-1", email: "user@example.com" },
    });
    markProviderOAuthReauthRequired(ctx.db, ctx.provider.id, view.id);
    await assert.rejects(
      () => ctx.service.resolveManaged(ctx.provider.id, view.id),
      /must be reconnected/,
    );
  } finally {
    ctx.close();
  }
});

test("testManaged revives reauth_required rows instead of failing canned", async () => {
  let refreshes = 0;
  const ctx = setup(Date.now() + 60 * 60_000, {
    async refresh(value) {
      refreshes++;
      return {
        ...value,
        secrets: { ...value.secrets, accessToken: "refreshed-token" },
        expiresAt: Date.now() + 60 * 60_000,
      };
    },
  });
  try {
    const view = getProviderOAuthView(ctx.db, ctx.provider.id)!;
    markProviderOAuthReauthRequired(ctx.db, ctx.provider.id, view.id);
    const result = await ctx.service.testManaged(ctx.provider.id);
    assert.equal(result.ok, true);
    assert.equal(refreshes, 1);
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id)?.status,
      "active",
    );
  } finally {
    ctx.close();
  }
});

test("testManaged reports revival failure as a failed probe", async () => {
  const ctx = setup(Date.now() - 1, {
    async refresh() {
      throw new Error("network unavailable");
    },
  });
  try {
    const view = getProviderOAuthView(ctx.db, ctx.provider.id)!;
    markProviderOAuthReauthRequired(ctx.db, ctx.provider.id, view.id);
    const result = await ctx.service.testManaged(ctx.provider.id);
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.equal(result.error, "network unavailable");
    assert.deepEqual(result.models, []);
  } finally {
    ctx.close();
  }
});

test("sweep proactively refreshes near-expiry active rows", async () => {
  const ctx = setup(Date.now() + 10 * 60_000);
  try {
    assert.deepEqual(await ctx.service.sweepTokenRefreshes(), {
      refreshed: 1,
      failed: 0,
    });
    const stored = getProviderOAuth(ctx.db, ctx.crypto, ctx.provider.id)!;
    assert.equal(stored.credential.secrets.accessToken, "refreshed-token");
  } finally {
    ctx.close();
  }
});

test("sweep revival failure backs off instead of hammering the token endpoint", async () => {
  let refreshes = 0;
  const ctx = setup(Date.now() - 1, {
    async refresh() {
      refreshes++;
      throw new Error("network unavailable");
    },
  });
  try {
    const view = getProviderOAuthView(ctx.db, ctx.provider.id)!;
    markProviderOAuthReauthRequired(ctx.db, ctx.provider.id, view.id);
    assert.deepEqual(await ctx.service.sweepTokenRefreshes(), {
      refreshed: 0,
      failed: 1,
    });
    assert.equal(refreshes, 1);
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id)?.status,
      "reauth_required",
    );
    // Backoff: an immediate second sweep must not re-post the refresh token.
    assert.deepEqual(await ctx.service.sweepTokenRefreshes(), {
      refreshed: 0,
      failed: 0,
    });
    assert.equal(refreshes, 1);
  } finally {
    ctx.close();
  }
});

test("sweep skips disabled rows and healthy active rows", async () => {
  let refreshes = 0;
  const ctx = setup(Date.now() - 1, {
    async refresh(value) {
      refreshes++;
      return value;
    },
  });
  try {
    // Disabled row that would otherwise be due (already expired).
    const disabled = getProviderOAuthView(ctx.db, ctx.provider.id)!;
    setProviderOAuthEnabled(ctx.db, ctx.provider.id, disabled.id, false);
    // Second row: active but far from expiry → outside the 15-minute window.
    createProviderOAuth(ctx.db, ctx.crypto, ctx.provider.id, {
      integrationId: "clinefree",
      secrets: { accessToken: "other", refreshToken: "other-refresh" },
      expiresAt: Date.now() + 60 * 60_000,
      account: { accountId: "account-2", email: "other@example.com" },
    });
    assert.deepEqual(await ctx.service.sweepTokenRefreshes(), {
      refreshed: 0,
      failed: 0,
    });
    assert.equal(refreshes, 0);
  } finally {
    ctx.close();
  }
});
