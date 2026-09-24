import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from ".";
import { ProviderAuthCrypto } from "../services/provider-auth/crypto";
import { migrateClaudeCodePlainKeysToManagedAuth } from "./migrate-claude-code-oauth";
import { createProvider } from "../repo/providers";
import { createProviderKey, listProviderKeys } from "../repo/provider-keys";
import { getProviderOAuth, listProviderOAuthViews } from "../repo/provider-oauth";
import { NEVER_EXPIRES } from "../services/provider-auth/types";
import { WireKind } from "../types";

function withTempDb(fn: (dir: string, file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-migration-"));
  const file = path.join(dir, "test.db");
  try {
    fn(dir, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("migrates plain claude-code API keys into encrypted managed-auth credentials", () => {
  withTempDb((dir, file) => {
    const db = openDatabase(file);
    try {
      const provider = createProvider(db, {
        name: "claude-code",
        baseUrl: "https://api.anthropic.com",
        catalogId: "claude-code",
        endpoints: [WireKind.Messages],
      });
      createProviderKey(db, provider.id, { credential: "sk-ant-api03-plain-key-one" });
      createProviderKey(db, provider.id, {
        credential: "sk-ant-api03-plain-key-two",
        label: "secondary",
      });

      const crypto = new ProviderAuthCrypto(db, dir);
      migrateClaudeCodePlainKeysToManagedAuth(db, crypto);

      // Plaintext rows are gone.
      assert.equal(listProviderKeys(db, provider.id).length, 0);

      // Both re-appear as encrypted managed-auth credentials.
      const views = listProviderOAuthViews(db, provider.id);
      assert.equal(views.length, 2);
      for (const view of views) {
        assert.equal(view.integrationId, "claude-code");
        assert.equal(view.status, "active");
        const stored = getProviderOAuth(db, crypto, provider.id, view.id)!;
        assert.match(stored.credential.secrets.accessToken, /^sk-ant-api03-plain-key-/);
        assert.equal(stored.credential.secrets.refreshToken, undefined);
        assert.equal(stored.credential.expiresAt, NEVER_EXPIRES);
        // Not OAuth-prefixed -> plain API key, never refreshable.
        assert.equal(stored.credential.account.tokenKind, "long_lived");
        assert.equal(stored.credential.account.authKind, "api_key");
      }
    } finally {
      closeDatabase(db);
    }
  });
});

test("classifies a pre-existing sk-ant-oat01- key as an OAuth token, not a plain key", () => {
  withTempDb((dir, file) => {
    const db = openDatabase(file);
    try {
      const provider = createProvider(db, {
        name: "claude-code",
        baseUrl: "https://api.anthropic.com",
        catalogId: "claude-code",
        endpoints: [WireKind.Messages],
      });
      createProviderKey(db, provider.id, {
        credential: "sk-ant-oat01-preexisting-long-lived-token",
      });

      const crypto = new ProviderAuthCrypto(db, dir);
      migrateClaudeCodePlainKeysToManagedAuth(db, crypto);

      const views = listProviderOAuthViews(db, provider.id);
      assert.equal(views.length, 1);
      const stored = getProviderOAuth(db, crypto, provider.id, views[0]!.id)!;
      assert.equal(stored.credential.account.tokenKind, "long_lived");
      assert.equal(stored.credential.account.authKind, "oauth_token");
    } finally {
      closeDatabase(db);
    }
  });
});

test("is a no-op for providers with no keys, and idempotent on re-run", () => {
  withTempDb((dir, file) => {
    const db = openDatabase(file);
    try {
      const provider = createProvider(db, {
        name: "claude-code",
        baseUrl: "https://api.anthropic.com",
        catalogId: "claude-code",
        endpoints: [WireKind.Messages],
      });
      const crypto = new ProviderAuthCrypto(db, dir);

      migrateClaudeCodePlainKeysToManagedAuth(db, crypto);
      assert.equal(listProviderOAuthViews(db, provider.id).length, 0);

      createProviderKey(db, provider.id, { credential: "sk-ant-api03-later-key" });
      migrateClaudeCodePlainKeysToManagedAuth(db, crypto);
      assert.equal(listProviderOAuthViews(db, provider.id).length, 1);

      // Re-running with nothing left in provider_keys changes nothing.
      migrateClaudeCodePlainKeysToManagedAuth(db, crypto);
      assert.equal(listProviderOAuthViews(db, provider.id).length, 1);
    } finally {
      closeDatabase(db);
    }
  });
});

test("does not touch providers on other catalogIds", () => {
  withTempDb((dir, file) => {
    const db = openDatabase(file);
    try {
      const other = createProvider(db, {
        name: "openai",
        baseUrl: "https://api.openai.com",
        catalogId: "openai",
        endpoints: [WireKind.Chat],
      });
      createProviderKey(db, other.id, { credential: "sk-plain-openai-key" });

      const crypto = new ProviderAuthCrypto(db, dir);
      migrateClaudeCodePlainKeysToManagedAuth(db, crypto);

      assert.equal(listProviderKeys(db, other.id).length, 1);
      assert.equal(listProviderOAuthViews(db, other.id).length, 0);
    } finally {
      closeDatabase(db);
    }
  });
});
