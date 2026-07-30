import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from ".";
import {
  ProviderAuthCrypto,
  migrateProviderAuthIdentifiers,
} from "../services/provider-auth/crypto";

function legacySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      catalog_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_oauth_credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL UNIQUE REFERENCES providers(id) ON DELETE CASCADE,
      integration_id TEXT NOT NULL,
      encrypted_secrets TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      public_metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO providers
      (id, name, base_url, catalog_id, created_at, updated_at)
    VALUES
      ('provider', 'Cline Free', 'https://api.cline.bot', 'cline-free', '', '');
  `);
}

test("legacy OAuth table migrates to multiple account rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-table-migration-"));
  const file = path.join(dir, "old.db");
  try {
    const raw = new Database(file);
    legacySchema(raw);
    raw.prepare(
      `INSERT INTO provider_oauth_credentials
       (id, provider_id, integration_id, encrypted_secrets, expires_at,
        public_metadata, status, revision, created_at, updated_at)
       VALUES ('row-one', 'provider', 'test', 'ciphertext', 1, ?, 'disabled', 7, 'created', 'updated')`,
    ).run(JSON.stringify({ accountId: "account-1", email: "USER@example.com" }));
    raw.close();

    const db = openDatabase(file);
    const row = db
      .prepare("SELECT * FROM provider_oauth_credentials WHERE id = 'row-one'")
      .get() as Record<string, unknown>;
    assert.equal(row.encrypted_secrets, "ciphertext");
    assert.equal(row.revision, 7);
    assert.equal(row.status, "disabled");
    assert.equal(row.created_at, "created");
    assert.equal(row.updated_at, "updated");
    assert.equal(row.account_identity, "account:account-1");

    db.prepare(
      `INSERT INTO provider_oauth_credentials
       (id, provider_id, integration_id, account_identity, encrypted_secrets,
        expires_at, public_metadata, status, revision, created_at, updated_at)
       VALUES ('row-two', 'provider', 'test', 'account:account-2', 'other', 2,
        '{}', 'active', 1, '', '')`,
    ).run();
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM provider_oauth_credentials WHERE provider_id = 'provider'",
          )
          .get() as { n: number }
      ).n,
      2,
    );
    closeDatabase(db);

    const db2 = openDatabase(file);
    closeDatabase(db2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Cline identifier migration re-encrypts authenticated AAD atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-aad-migration-"));
  const file = path.join(dir, "old.db");
  try {
    const raw = new Database(file);
    legacySchema(raw);
    raw.close();

    const db = openDatabase(file);
    const crypto = new ProviderAuthCrypto(db, dir);
    const secrets = { accessToken: "access", refreshToken: "refresh" };
    const encrypted = crypto.encrypt("row-one", "cline-free", secrets);
    db.prepare(
      `INSERT INTO provider_oauth_credentials
       (id, provider_id, integration_id, account_identity, encrypted_secrets,
        expires_at, public_metadata, status, revision, created_at, updated_at)
       VALUES ('row-one', 'provider', 'cline-free', 'account:one', ?, 1,
        '{}', 'active', 1, '', '')`,
    ).run(encrypted);

    migrateProviderAuthIdentifiers(db, crypto);
    const row = db
      .prepare(
        "SELECT integration_id, encrypted_secrets FROM provider_oauth_credentials WHERE id = 'row-one'",
      )
      .get() as { integration_id: string; encrypted_secrets: string };
    assert.equal(row.integration_id, "clinefree");
    assert.deepEqual(
      crypto.decrypt("row-one", "clinefree", row.encrypted_secrets),
      secrets,
    );
    assert.throws(() =>
      crypto.decrypt("row-one", "cline-free", row.encrypted_secrets),
    );
    assert.equal(
      (
        db.prepare("SELECT catalog_id FROM providers WHERE id='provider'").get() as {
          catalog_id: string;
        }
      ).catalog_id,
      "clinefree",
    );

    migrateProviderAuthIdentifiers(db, crypto);
    closeDatabase(db);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
