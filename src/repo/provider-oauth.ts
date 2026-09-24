import { createHash, randomBytes } from "crypto";
import type { Database as DB } from "better-sqlite3";
import type {
  ProviderAuthAccount,
  ProviderAuthCredential,
} from "../services/provider-auth/types";
import type { ProviderAuthCrypto } from "../services/provider-auth/crypto";
import { parseJsonObject } from "./json";

interface OAuthViewRow {
  id: string;
  provider_id: string;
  integration_id: string;
  account_identity: string | null;
  expires_at: number;
  public_metadata: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface OAuthRow extends OAuthViewRow {
  encrypted_secrets: string;
  revision: number;
}

export interface ProviderOAuthView {
  id: string;
  providerId: string;
  kind: "oauth";
  integrationId: string;
  credHash: string;
  status: "active" | "disabled" | "reauth_required";
  expiresAt: string;
  // Reuses the same shape ProviderAuthCredential.account carries, since this
  // is literally that object's PUBLIC half round-tripped through
  // public_metadata (JSON.stringify(credential.account) on write,
  // parseJsonObject(row.public_metadata, {}) on read below) - one shape for
  // a credential's non-secret identity/classification data everywhere it's
  // seen, from import-time assembly through to the admin/session views.
  account: ProviderAuthAccount;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderOAuthAdminView extends ProviderOAuthView {
  accessToken: string;
}

export interface StoredProviderOAuth extends ProviderOAuthView {
  revision: number;
  credential: ProviderAuthCredential;
}

export interface BatchOAuthOps {
  enable?: string[];
  disable?: string[];
  remove?: string[];
}

export interface BatchOAuthResult {
  enabled: number;
  disabled: number;
  removed: number;
  errors: Array<{ op: string; id: string; detail: string }>;
  accounts: ProviderOAuthView[];
}

const VIEW_COLUMNS =
  "id, provider_id, integration_id, account_identity, expires_at, public_metadata, status, created_at, updated_at";

function oauthHealthKey(id: string): string {
  return `oauth:${id}`;
}

function oauthCredHash(id: string): string {
  return createHash("sha256")
    .update(oauthHealthKey(id))
    .digest("hex")
    .slice(0, 32);
}

function accountIdentity(
  account: ProviderAuthCredential["account"],
): string | null {
  const accountId = account.accountId?.trim();
  if (accountId) return `account:${accountId}`;
  const email = account.email?.trim().toLowerCase();
  return email ? `email:${email}` : null;
}

function mapView(row: OAuthViewRow): ProviderOAuthView {
  return {
    id: row.id,
    providerId: row.provider_id,
    kind: "oauth",
    integrationId: row.integration_id,
    credHash: oauthCredHash(row.id),
    status:
      row.status === "disabled"
        ? "disabled"
        : row.status === "reauth_required"
          ? "reauth_required"
          : "active",
    expiresAt: new Date(row.expires_at).toISOString(),
    account: parseJsonObject(row.public_metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Every "oldest first" ordering below tie-breaks on rowid, NOT on id: the id is
// random (see createProviderOAuth), so `ORDER BY created_at, id` orders rows
// inserted within the same millisecond (created_at is ms-resolution) randomly.
// That is not merely a display nuisance - firstRow() picks the account a live
// request runs as when no account is pinned, so a random tie-break made that
// pick nondeterministic for a freshly-imported provider. rowid is SQLite's
// insertion counter, so "oldest first" is exact.
function rowById(db: DB, providerId: string, id: string): OAuthRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM provider_oauth_credentials WHERE id = ? AND provider_id = ?",
      )
      .get(id, providerId) as OAuthRow | undefined) ?? null
  );
}

function firstRow(db: DB, providerId: string): OAuthRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM provider_oauth_credentials WHERE provider_id = ? ORDER BY created_at, rowid LIMIT 1",
      )
      .get(providerId) as OAuthRow | undefined) ?? null
  );
}

function storedFromRow(
  crypto: ProviderAuthCrypto,
  row: OAuthRow,
): StoredProviderOAuth {
  const secrets = crypto.decrypt<ProviderAuthCredential["secrets"]>(
    row.id,
    row.integration_id,
    row.encrypted_secrets,
  );
  return {
    revision: row.revision,
    ...mapView(row),
    credential: {
      integrationId: row.integration_id,
      secrets,
      expiresAt: row.expires_at,
      account: parseJsonObject(row.public_metadata, {}),
    },
  };
}

export function listProviderOAuthViews(
  db: DB,
  providerId: string,
): ProviderOAuthView[] {
  const rows = db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM provider_oauth_credentials
       WHERE provider_id = ? ORDER BY created_at, rowid`,
    )
    .all(providerId) as OAuthViewRow[];
  return rows.map(mapView);
}

export function listAllProviderOAuthViews(
  db: DB,
): Map<string, ProviderOAuthView[]> {
  const rows = db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM provider_oauth_credentials ORDER BY created_at, rowid`,
    )
    .all() as OAuthViewRow[];
  const result = new Map<string, ProviderOAuthView[]>();
  for (const row of rows) {
    const views = result.get(row.provider_id) ?? [];
    views.push(mapView(row));
    result.set(row.provider_id, views);
  }
  return result;
}

export function listActiveProviderOAuthHealthKeys(
  db: DB,
  providerId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM provider_oauth_credentials
       WHERE provider_id = ? AND status = 'active' ORDER BY created_at, rowid`,
    )
    .all(providerId) as Array<{ id: string }>;
  return rows.map((row) => oauthHealthKey(row.id));
}

export function getProviderOAuthView(
  db: DB,
  providerId: string,
  id?: string,
): ProviderOAuthView | null {
  const row = id
    ? (db
        .prepare(
          `SELECT ${VIEW_COLUMNS} FROM provider_oauth_credentials
           WHERE id = ? AND provider_id = ?`,
        )
        .get(id, providerId) as OAuthViewRow | undefined)
    : (db
        .prepare(
          `SELECT ${VIEW_COLUMNS} FROM provider_oauth_credentials
           WHERE provider_id = ? ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(providerId) as OAuthViewRow | undefined);
  return row ? mapView(row) : null;
}

export function getProviderOAuth(
  db: DB,
  crypto: ProviderAuthCrypto,
  providerId: string,
  id?: string,
): StoredProviderOAuth | null {
  const row = id ? rowById(db, providerId, id) : firstRow(db, providerId);
  return row ? storedFromRow(crypto, row) : null;
}

export function listProviderOAuthAdminViews(
  db: DB,
  crypto: ProviderAuthCrypto,
  providerId: string,
): ProviderOAuthAdminView[] {
  const rows = db
    .prepare(
      "SELECT * FROM provider_oauth_credentials WHERE provider_id = ? ORDER BY created_at, rowid",
    )
    .all(providerId) as OAuthRow[];
  return rows.map((row) => {
    const stored = storedFromRow(crypto, row);
    return {
      ...mapView(row),
      accessToken: stored.credential.secrets.accessToken,
    };
  });
}

export function createProviderOAuth(
  db: DB,
  crypto: ProviderAuthCrypto,
  providerId: string,
  credential: ProviderAuthCredential,
): ProviderOAuthView {
  const identity = accountIdentity(credential.account);
  const existing = identity
    ? (db
        .prepare(
          `SELECT id FROM provider_oauth_credentials
           WHERE provider_id = ? AND integration_id = ? AND account_identity = ?`,
        )
        .get(providerId, credential.integrationId, identity) as
        { id: string } | undefined)
    : undefined;
  if (existing)
    return replaceProviderOAuth(
      db,
      crypto,
      providerId,
      existing.id,
      credential,
    );

  const id = randomBytes(8).toString("hex");
  const now = new Date().toISOString();
  const encrypted = crypto.encrypt(
    id,
    credential.integrationId,
    credential.secrets,
  );
  db.prepare(
    `INSERT INTO provider_oauth_credentials
      (id, provider_id, integration_id, account_identity, encrypted_secrets,
       expires_at, public_metadata, status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
  ).run(
    id,
    providerId,
    credential.integrationId,
    identity,
    encrypted,
    credential.expiresAt,
    JSON.stringify(credential.account),
    now,
    now,
  );
  return getProviderOAuthView(db, providerId, id)!;
}

export function replaceProviderOAuth(
  db: DB,
  crypto: ProviderAuthCrypto,
  providerId: string,
  id: string,
  credential: ProviderAuthCredential,
): ProviderOAuthView {
  const existing = rowById(db, providerId, id);
  if (!existing) throw new Error("Provider authentication account not found");
  const now = new Date().toISOString();
  const encrypted = crypto.encrypt(
    existing.id,
    credential.integrationId,
    credential.secrets,
  );
  db.prepare(
    `UPDATE provider_oauth_credentials SET integration_id=?, account_identity=?,
       encrypted_secrets=?, expires_at=?, public_metadata=?, status='active',
       revision=revision+1, updated_at=? WHERE id=? AND provider_id=?`,
  ).run(
    credential.integrationId,
    accountIdentity(credential.account),
    encrypted,
    credential.expiresAt,
    JSON.stringify(credential.account),
    now,
    id,
    providerId,
  );
  return getProviderOAuthView(db, providerId, id)!;
}

export function rotateProviderOAuth(
  db: DB,
  crypto: ProviderAuthCrypto,
  current: StoredProviderOAuth,
  credential: ProviderAuthCredential,
): boolean {
  const now = new Date().toISOString();
  const encrypted = crypto.encrypt(
    current.id,
    credential.integrationId,
    credential.secrets,
  );
  // A refresh()'d credential's `account` is freshly built by the
  // integration - it has no idea an admin set a custom label or tags on
  // this row, so those would otherwise be silently wiped on every routine
  // token rotation. Carry them forward from the row on file whenever the
  // fresh credential doesn't explicitly specify its own (an integration
  // that DOES resolve a real label - e.g. a newly-available profile email -
  // still wins, exactly like today).
  const account: ProviderAuthAccount = {
    ...credential.account,
    label: credential.account.label ?? current.credential.account.label,
    tags: credential.account.tags ?? current.credential.account.tags,
  };
  const result = db
    .prepare(
      `UPDATE provider_oauth_credentials SET integration_id=?, account_identity=?,
       encrypted_secrets=?, expires_at=?, public_metadata=?, status='active',
       revision=revision+1, updated_at=? WHERE id=? AND provider_id=? AND revision=?`,
    )
    .run(
      credential.integrationId,
      accountIdentity(account),
      encrypted,
      credential.expiresAt,
      JSON.stringify(account),
      now,
      current.id,
      current.providerId,
      current.revision,
    );
  return result.changes === 1;
}

export function setProviderOAuthEnabled(
  db: DB,
  providerId: string,
  id: string,
  enabled: boolean,
): ProviderOAuthView | null {
  const current = getProviderOAuthView(db, providerId, id);
  if (!current) return null;
  if (enabled && current.status === "reauth_required")
    throw new Error("Provider authentication must be reconnected");
  const status = enabled ? "active" : "disabled";
  if (current.status !== status)
    db.prepare(
      `UPDATE provider_oauth_credentials SET status=?, updated_at=?
       WHERE id=? AND provider_id=?`,
    ).run(status, new Date().toISOString(), id, providerId);
  return getProviderOAuthView(db, providerId, id)!;
}

// Updates ONLY the admin-editable, non-secret display fields (label, tags) -
// same purpose as provider-keys.ts's label/metadata update, kept separate
// from rotateProviderOAuth (which replaces the whole account object as part
// of a credential refresh) so editing a tag never touches secrets, status,
// or revision/expiry.
export function updateProviderOAuthMetadata(
  db: DB,
  providerId: string,
  id: string,
  patch: { label?: string | null; tags?: Record<string, string> },
): ProviderOAuthView | null {
  const current = getProviderOAuthView(db, providerId, id);
  if (!current) return null;
  const account: ProviderAuthAccount = {
    ...current.account,
    label:
      patch.label === undefined
        ? current.account.label
        : patch.label || undefined,
    tags: patch.tags === undefined ? current.account.tags : patch.tags,
  };
  db.prepare(
    `UPDATE provider_oauth_credentials SET public_metadata=?, updated_at=?
     WHERE id=? AND provider_id=?`,
  ).run(JSON.stringify(account), new Date().toISOString(), id, providerId);
  return getProviderOAuthView(db, providerId, id)!;
}

export function deleteProviderOAuth(
  db: DB,
  providerId: string,
  id: string,
): boolean {
  return (
    db
      .prepare(
        "DELETE FROM provider_oauth_credentials WHERE id = ? AND provider_id = ?",
      )
      .run(id, providerId).changes === 1
  );
}

export function markProviderOAuthReauthRequired(
  db: DB,
  providerId: string,
  id: string,
): void {
  db.prepare(
    `UPDATE provider_oauth_credentials SET status='reauth_required', updated_at=?
     WHERE id=? AND provider_id=? AND status='active'`,
  ).run(new Date().toISOString(), id, providerId);
}

export function batchProviderOAuth(
  db: DB,
  providerId: string,
  ops: BatchOAuthOps,
): BatchOAuthResult {
  const result: BatchOAuthResult = {
    enabled: 0,
    disabled: 0,
    removed: 0,
    errors: [],
    accounts: [],
  };
  const tx = db.transaction(() => {
    for (const id of ops.enable ?? []) {
      try {
        const before = getProviderOAuthView(db, providerId, id);
        const after = setProviderOAuthEnabled(db, providerId, id, true);
        if (!after)
          result.errors.push({ op: "enable", id, detail: "not found" });
        else if (before?.status !== "active") result.enabled++;
      } catch (error) {
        result.errors.push({
          op: "enable",
          id,
          detail: (error as Error).message,
        });
      }
    }
    for (const id of ops.disable ?? []) {
      try {
        const before = getProviderOAuthView(db, providerId, id);
        const after = setProviderOAuthEnabled(db, providerId, id, false);
        if (!after)
          result.errors.push({ op: "disable", id, detail: "not found" });
        else if (before?.status !== "disabled") result.disabled++;
      } catch (error) {
        result.errors.push({
          op: "disable",
          id,
          detail: (error as Error).message,
        });
      }
    }
    for (const id of ops.remove ?? []) {
      if (deleteProviderOAuth(db, providerId, id)) result.removed++;
      else result.errors.push({ op: "remove", id, detail: "not found" });
    }
  });
  tx();
  result.accounts = listProviderOAuthViews(db, providerId);
  return result;
}
