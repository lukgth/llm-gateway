import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Database as DB } from "better-sqlite3";

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function hasEncryptedRows(db: DB): boolean {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_oauth_credentials'",
    )
    .get();
  if (!table) return false;
  return !!db.prepare("SELECT 1 FROM provider_oauth_credentials LIMIT 1").get();
}

function loadOrCreateKey(db: DB, filePath: string): Buffer {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("must decode to 32 bytes");
    if (
      process.platform !== "win32" &&
      (fs.statSync(filePath).mode & 0o077) !== 0
    )
      throw new Error("must not be accessible by group or other users");
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      throw new Error(`Invalid provider OAuth key file: ${(error as Error).message}`);
    if (hasEncryptedRows(db))
      throw new Error(
        "Provider OAuth key file is missing while encrypted credentials exist",
      );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(filePath, key.toString("base64") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return key;
  }
}

export function migrateProviderAuthIdentifiers(
  db: DB,
  crypto: ProviderAuthCrypto,
): void {
  const rows = db
    .prepare(
      `SELECT id, encrypted_secrets FROM provider_oauth_credentials
       WHERE integration_id = 'cline-free'`,
    )
    .all() as Array<{ id: string; encrypted_secrets: string }>;
  if (!rows.length) {
    db.prepare(
      "UPDATE providers SET catalog_id = 'clinefree' WHERE catalog_id = 'cline-free'",
    ).run();
    return;
  }
  const update = db.prepare(
    `UPDATE provider_oauth_credentials
     SET integration_id = 'clinefree', encrypted_secrets = ?, updated_at = ?
     WHERE id = ? AND integration_id = 'cline-free'`,
  );
  const now = new Date().toISOString();
  const migrated = rows.map((row) => {
    const secrets = crypto.decrypt<unknown>(
      row.id,
      "cline-free",
      row.encrypted_secrets,
    );
    return {
      id: row.id,
      encrypted: crypto.encrypt(row.id, "clinefree", secrets),
    };
  });
  const tx = db.transaction(() => {
    for (const row of migrated) update.run(row.encrypted, now, row.id);
    db.prepare(
      "UPDATE providers SET catalog_id = 'clinefree' WHERE catalog_id = 'cline-free'",
    ).run();
  });
  tx();
}

export class ProviderAuthCrypto {
  private readonly key: Buffer;

  constructor(db: DB, dataDir: string) {
    this.key = loadOrCreateKey(
      db,
      path.join(dataDir, "provider-oauth.key"),
    );
  }

  encrypt(recordId: string, integrationId: string, value: unknown): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`provider-oauth:v1:${recordId}:${integrationId}`));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    return JSON.stringify(envelope);
  }

  decrypt<T>(recordId: string, integrationId: string, raw: string): T {
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.v !== 1) throw new Error("Unsupported provider OAuth envelope");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`provider-oauth:v1:${recordId}:${integrationId}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const data = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(data.toString("utf8")) as T;
  }
}
