// Gateway API-key repository.
//
// Gateway keys are the credentials *clients* present to this gateway. We store
// a SHA-256 hash for O(1) auth lookup and a short prefix for display. The full
// key is returned in-memory from create() so the UI can show it once; it is
// never persisted or re-readable from the DB.

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import type { ApiKey } from "../types";
import { sha256 } from "../config";
import { slugify } from "./providers";

export const KEY_PREFIX = "sk-";

// Alphabet for generated key payloads.
const KEY_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const KEY_PAYLOAD_LENGTH = 24;

interface ApiKeyRow {
  id: string;
  name: string | null;
  key_prefix: string;
  key_hash: string;
  user_id: string | null;
  tokens_per_day: number | null;
  enabled: number;
  access_all_models: number;
  last_used_at: string | null;
  created_at: string;
  user_name: string | null;
}

const SELECT_JOIN =
  "SELECT k.*, u.name AS user_name FROM api_keys k " +
  "LEFT JOIN users u ON u.id = k.user_id";

function modelIdsForKeys(db: DB, keyIds: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const id of keyIds) result.set(id, []);
  if (keyIds.length === 0) return result;
  const placeholders = keyIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT api_key_id, model_id FROM api_key_models
       WHERE api_key_id IN (${placeholders}) ORDER BY model_id`,
    )
    .all(...keyIds) as Array<{ api_key_id: string; model_id: string }>;
  for (const row of rows) result.get(row.api_key_id)?.push(row.model_id);
  return result;
}

function mapKeys(db: DB, rows: ApiKeyRow[]): ApiKey[] {
  const modelIds = modelIdsForKeys(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    userId: r.user_id,
    userName: r.user_name,
    tokensPerDay: r.tokens_per_day,
    enabled: !!r.enabled,
    accessAllModels: !!r.access_all_models,
    modelIds: modelIds.get(r.id) || [],
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

function mapKey(db: DB, row: ApiKeyRow): ApiKey {
  return mapKeys(db, [row])[0];
}

// Generate "sk-" + 24 alphanumeric chars, sampled uniformly (rejection
// sampling avoids modulo bias). ~143 bits of entropy.
export function generateKey(): string {
  let payload = "";
  while (payload.length < KEY_PAYLOAD_LENGTH) {
    for (const byte of crypto.randomBytes(KEY_PAYLOAD_LENGTH)) {
      if (byte < KEY_ALPHABET.length * 4) {
        payload += KEY_ALPHABET[byte % KEY_ALPHABET.length];
        if (payload.length === KEY_PAYLOAD_LENGTH) break;
      }
    }
  }
  return KEY_PREFIX + payload;
}

// Human-friendly masked form, e.g. "sk-bHP7x3S…MNqP".
export function maskKey(full: string): string {
  if (full.length <= 12) return full;
  return `${full.slice(0, 10)}…${full.slice(-4)}`;
}

// Cheap existence checks used by the per-request auth middleware.
export function countApiKeys(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as {
    n: number;
  };
  return row.n;
}

export function countEnabledApiKeys(db: DB): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE enabled = 1")
    .get() as { n: number };
  return row.n;
}

export function listApiKeys(db: DB): ApiKey[] {
  const rows = db
    .prepare(`${SELECT_JOIN} ORDER BY k.created_at DESC`)
    .all() as ApiKeyRow[];
  return mapKeys(db, rows);
}

export function getApiKey(db: DB, id: string): ApiKey | null {
  const row = db.prepare(`${SELECT_JOIN} WHERE k.id = ?`).get(id) as
    ApiKeyRow | undefined;
  return row ? mapKey(db, row) : null;
}

// Auth lookup: find an enabled key by the hash of the presented secret.
export function getApiKeyByHash(db: DB, hash: string): ApiKey | null {
  const row = db
    .prepare(`${SELECT_JOIN} WHERE k.key_hash = ? AND k.enabled = 1`)
    .get(hash) as ApiKeyRow | undefined;
  return row ? mapKey(db, row) : null;
}

// Auth lookup that intentionally includes disabled keys so the gateway can
// distinguish "known but revoked" from "not a key we issued" and return a
// configurable operator-friendly error message.
export function getAnyApiKeyByHash(db: DB, hash: string): ApiKey | null {
  const row = db.prepare(`${SELECT_JOIN} WHERE k.key_hash = ?`).get(hash) as
    ApiKeyRow | undefined;
  return row ? mapKey(db, row) : null;
}

export interface ApiKeyInput {
  id?: string;
  name?: string | null;
  userId?: string | null;
  tokensPerDay?: number | null;
  enabled?: boolean;
  accessAllModels?: boolean;
  modelIds?: string[];
}

function normalizedScope(input: Partial<ApiKeyInput>): {
  accessAllModels: boolean;
  modelIds: string[];
} | null {
  const hasMode = input.accessAllModels !== undefined;
  const hasIds = input.modelIds !== undefined;
  if (!hasMode && !hasIds) return null;
  if (!hasMode) throw new Error("accessAllModels is required with modelIds");
  if (!hasIds && input.accessAllModels === false)
    throw new Error("modelIds is required when accessAllModels is false");
  const modelIds = [...new Set(input.modelIds || [])];
  if (input.accessAllModels && modelIds.length > 0)
    throw new Error("modelIds must be empty when accessAllModels is true");
  return { accessAllModels: input.accessAllModels!, modelIds };
}

function validateModelIds(db: DB, modelIds: string[]): void {
  if (modelIds.length === 0) return;
  const placeholders = modelIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM models WHERE id IN (${placeholders})`)
    .all(...modelIds) as Array<{ id: string }>;
  const found = new Set(rows.map((row) => row.id));
  const missing = modelIds.filter((id) => !found.has(id));
  if (missing.length)
    throw new Error(`Unknown exposed model id(s): ${missing.join(", ")}`);
}

function replaceScope(
  db: DB,
  keyId: string,
  scope: { accessAllModels: boolean; modelIds: string[] },
): void {
  validateModelIds(db, scope.modelIds);
  db.prepare("DELETE FROM api_key_models WHERE api_key_id = ?").run(keyId);
  db.prepare("UPDATE api_keys SET access_all_models = ? WHERE id = ?").run(
    scope.accessAllModels ? 1 : 0,
    keyId,
  );
  if (!scope.accessAllModels) {
    const insert = db.prepare(
      "INSERT INTO api_key_models (api_key_id, model_id) VALUES (?, ?)",
    );
    for (const modelId of scope.modelIds) insert.run(keyId, modelId);
  }
}

// Create a key. If `key` is omitted, a fresh random one is generated. Returns
// the ApiKey with `keyFull` populated so the caller can show it once.
export function createApiKey(
  db: DB,
  input: ApiKeyInput,
  key?: string,
): ApiKey & { keyFull: string } {
  const full = key && key.length ? key : generateKey();
  const create = db.transaction(() => {
    const now = new Date().toISOString();
    const id =
      input.id ||
      (input.name ? slugify(input.name) : "") ||
      `key-${crypto.randomBytes(6).toString("hex")}`;
    if (getApiKey(db, id)) throw new Error(`API key '${id}' already exists`);
    const scope = normalizedScope(input) || {
      accessAllModels: true,
      modelIds: [],
    };
    validateModelIds(db, scope.modelIds);

    db.prepare(
      `INSERT INTO api_keys
        (id, name, key_prefix, key_hash, user_id, tokens_per_day, enabled,
         access_all_models, last_used_at, created_at)
       VALUES (@id, @name, @key_prefix, @key_hash, @user_id, @tokens_per_day,
         @enabled, @access_all_models, @last_used_at, @created_at)`,
    ).run({
      id,
      name: input.name ?? null,
      key_prefix: maskKey(full),
      key_hash: sha256(full),
      user_id: input.userId ?? null,
      tokens_per_day:
        input.tokensPerDay !== undefined && input.tokensPerDay !== null
          ? input.tokensPerDay
          : null,
      enabled: input.enabled === false ? 0 : 1,
      access_all_models: scope.accessAllModels ? 1 : 0,
      last_used_at: null,
      created_at: now,
    });
    if (!scope.accessAllModels) {
      const insert = db.prepare(
        "INSERT INTO api_key_models (api_key_id, model_id) VALUES (?, ?)",
      );
      for (const modelId of scope.modelIds) insert.run(id, modelId);
    }
    return { ...getApiKey(db, id)!, keyFull: full };
  });
  return create();
}

export function updateApiKey(
  db: DB,
  id: string,
  input: Partial<ApiKeyInput>,
): ApiKey | null {
  const update = db.transaction(() => {
    const existing = getApiKey(db, id);
    if (!existing) return null;
    const scope = normalizedScope(input);
    if (scope) validateModelIds(db, scope.modelIds);
    db.prepare(
      `UPDATE api_keys SET
         name=@name, user_id=@user_id, tokens_per_day=@tokens_per_day, enabled=@enabled
       WHERE id=@id`,
    ).run({
      id,
      name: input.name !== undefined ? input.name : existing.name,
      user_id: input.userId !== undefined ? input.userId : existing.userId,
      tokens_per_day:
        input.tokensPerDay !== undefined
          ? input.tokensPerDay === null
            ? null
            : input.tokensPerDay
          : existing.tokensPerDay,
      enabled:
        input.enabled !== undefined
          ? input.enabled
            ? 1
            : 0
          : existing.enabled
            ? 1
            : 0,
    });
    if (scope) replaceScope(db, id, scope);
    return getApiKey(db, id);
  });
  return update();
}

export function deleteApiKey(db: DB, id: string): boolean {
  const r = db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  return r.changes > 0;
}

export function touchLastUsed(db: DB, id: string): void {
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
}
