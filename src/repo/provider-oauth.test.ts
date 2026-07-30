import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from "../db";
import { createProvider, deleteProvider } from "./providers";
import {
  batchProviderOAuth,
  createProviderOAuth,
  deleteProviderOAuth,
  getProviderOAuth,
  getProviderOAuthView,
  listProviderOAuthAdminViews,
  listProviderOAuthViews,
  markProviderOAuthReauthRequired,
  replaceProviderOAuth,
  rotateProviderOAuth,
  setProviderOAuthEnabled,
} from "./provider-oauth";
import { ProviderAuthCrypto } from "../services/provider-auth/crypto";
import type { ProviderAuthCredential } from "../services/provider-auth/types";

function credential(
  suffix: string,
  expiresAt = Date.now() + 3_600_000,
): ProviderAuthCredential {
  return {
    integrationId: "clinefree",
    secrets: {
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
    },
    expiresAt,
    account: {
      accountId: `account-${suffix}`,
      email: `${suffix}@example.com`,
      label: `Account ${suffix}`,
    },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-oauth-repo-"));
  const db = openDatabase(":memory:");
  const provider = createProvider(db, {
    id: "provider-oauth",
    name: "OAuth provider",
    baseUrl: "https://example.com",
  });
  const crypto = new ProviderAuthCrypto(db, dir);
  return {
    db,
    provider,
    crypto,
    close() {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("provider OAuth supports multiple encrypted account rows", () => {
  const ctx = setup();
  try {
    const one = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      credential("one"),
    );
    const two = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      credential("two"),
    );

    assert.notEqual(one.id, two.id);
    assert.deepEqual(
      listProviderOAuthViews(ctx.db, ctx.provider.id).map((view) =>
        view.account.email,
      ),
      ["one@example.com", "two@example.com"],
    );
    const storedTwo = getProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      two.id,
    )?.credential;
    assert.equal(storedTwo?.integrationId, "clinefree");
    assert.deepEqual(storedTwo?.secrets, credential("two").secrets);
    assert.deepEqual(storedTwo?.account, credential("two").account);
    assert.equal(JSON.stringify(one).includes("access-one"), false);
    const admin = listProviderOAuthAdminViews(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
    );
    assert.equal(admin[0].accessToken, "access-one");
    assert.equal(JSON.stringify(admin).includes("refresh-one"), false);
  } finally {
    ctx.close();
  }
});

test("connecting the same upstream identity updates the existing row", () => {
  const ctx = setup();
  try {
    const initial = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      credential("same"),
    );
    const reconnect = credential("same");
    reconnect.secrets.accessToken = "new-access";
    reconnect.account.email = "changed@example.com";
    const updated = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      reconnect,
    );

    assert.equal(updated.id, initial.id);
    assert.equal(listProviderOAuthViews(ctx.db, ctx.provider.id).length, 1);
    assert.deepEqual(
      getProviderOAuth(
        ctx.db,
        ctx.crypto,
        ctx.provider.id,
        initial.id,
      )?.credential,
      reconnect,
    );
  } finally {
    ctx.close();
  }
});

test("OAuth account lifecycle and rotation target one row", () => {
  const ctx = setup();
  try {
    const one = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      credential("one"),
    );
    const two = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      credential("two"),
    );

    assert.equal(
      setProviderOAuthEnabled(ctx.db, ctx.provider.id, one.id, false)?.status,
      "disabled",
    );
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id, two.id)?.status,
      "active",
    );
    assert.equal(
      setProviderOAuthEnabled(ctx.db, ctx.provider.id, one.id, true)?.status,
      "active",
    );

    const stored = getProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      one.id,
    )!;
    const rotated = credential("rotated");
    assert.equal(rotateProviderOAuth(ctx.db, ctx.crypto, stored, rotated), true);
    assert.equal(
      rotateProviderOAuth(ctx.db, ctx.crypto, stored, credential("stale")),
      false,
    );

    markProviderOAuthReauthRequired(ctx.db, ctx.provider.id, one.id);
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id, one.id)?.status,
      "reauth_required",
    );
    assert.throws(
      () => setProviderOAuthEnabled(ctx.db, ctx.provider.id, one.id, true),
      /must be reconnected/,
    );
    replaceProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      one.id,
      credential("replacement"),
    );
    assert.equal(
      getProviderOAuthView(ctx.db, ctx.provider.id, one.id)?.status,
      "active",
    );
    assert.equal(deleteProviderOAuth(ctx.db, ctx.provider.id, one.id), true);
    assert.equal(getProviderOAuthView(ctx.db, ctx.provider.id, one.id), null);
    assert.ok(getProviderOAuthView(ctx.db, ctx.provider.id, two.id));
  } finally {
    ctx.close();
  }
});

test("OAuth account batch operations are provider-scoped", () => {
  const ctx = setup();
  try {
    const one = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      credential("one"),
    );
    const two = createProviderOAuth(
      ctx.db,
      ctx.crypto,
      ctx.provider.id,
      credential("two"),
    );
    const result = batchProviderOAuth(ctx.db, ctx.provider.id, {
      disable: [one.id],
      remove: [two.id, "missing"],
    });
    assert.equal(result.disabled, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].status, "disabled");
  } finally {
    ctx.close();
  }
});

test("deleting a provider cascades all OAuth accounts", () => {
  const ctx = setup();
  try {
    createProviderOAuth(ctx.db, ctx.crypto, ctx.provider.id, credential("one"));
    createProviderOAuth(ctx.db, ctx.crypto, ctx.provider.id, credential("two"));
    assert.equal(deleteProvider(ctx.db, ctx.provider.id), true);
    assert.deepEqual(listProviderOAuthViews(ctx.db, ctx.provider.id), []);
  } finally {
    ctx.close();
  }
});
