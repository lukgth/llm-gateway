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
