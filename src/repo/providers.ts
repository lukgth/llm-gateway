// Providers repository. CRUD + typed row mapping for upstream provider configs.

import type { Database as DB } from "better-sqlite3";
import type { AuthScheme, Provider, ProviderFormat } from "../shared/types";

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  host: string | null;
  api_keys: string;
  auth_scheme: string;
  extra_headers: string;
  retry_attempts: number;
  retry_interval_ms: number;
  request_timeout_ms: number;
  tls_verify: number;
  enabled: number;
  format: string;
  endpoints: string;
  native_conversion: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function mapProvider(r: ProviderRow): Provider {
  let apiKeys: string[] = [];
  try {
    const parsed = JSON.parse(r.api_keys);
    if (Array.isArray(parsed))
      apiKeys = parsed.filter((k) => typeof k === "string");
  } catch {
    apiKeys = [];
  }
  let extraHeaders: Record<string, string> = {};
  try {
    const parsed = JSON.parse(r.extra_headers);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      extraHeaders = parsed as Record<string, string>;
    }
  } catch {
    extraHeaders = {};
  }
  let endpoints: string[] = [];
  try {
    const parsed = JSON.parse(r.endpoints);
    if (Array.isArray(parsed))
      endpoints = parsed.filter((k) => typeof k === "string");
  } catch {
    endpoints = [];
  }
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    host: r.host,
    apiKeys,
    authScheme: (r.auth_scheme as AuthScheme) || "bearer",
    extraHeaders,
    retryAttempts: r.retry_attempts,
    retryIntervalMs: r.retry_interval_ms,
    requestTimeoutMs: r.request_timeout_ms,
    tlsVerify: !!r.tls_verify,
    enabled: !!r.enabled,
    format: (r.format as ProviderFormat) || "openai",
    endpoints,
    nativeConversion: !!r.native_conversion,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listProviders(db: DB, includeDisabled = true): Provider[] {
  const rows = db
    .prepare("SELECT * FROM providers ORDER BY sort_order, name")
    .all() as ProviderRow[];
  const all = rows.map(mapProvider);
  return includeDisabled ? all : all.filter((p) => p.enabled);
}

export function getProvider(db: DB, id: string): Provider | null {
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as
    ProviderRow | undefined;
  return row ? mapProvider(row) : null;
}

export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  host?: string | null;
  apiKeys?: string[];
  authScheme?: AuthScheme;
  extraHeaders?: Record<string, string>;
  retryAttempts?: number;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  tlsVerify?: boolean;
  enabled?: boolean;
  format?: ProviderFormat;
  endpoints?: string[];
  nativeConversion?: boolean;
}

export function createProvider(db: DB, input: ProviderInput): Provider {
  const now = new Date().toISOString();
  const id = input.id || slugify(input.name) || `prov-${Date.now()}`;
  if (getProvider(db, id)) throw new Error(`Provider '${id}' already exists`);
  const format = input.format || "openai";
  db.prepare(
    `INSERT INTO providers
      (id, name, base_url, host, api_keys, auth_scheme, extra_headers,
       retry_attempts, retry_interval_ms, request_timeout_ms, tls_verify,
       enabled, format, endpoints, native_conversion, sort_order, created_at, updated_at)
     VALUES (@id, @name, @base_url, @host, @api_keys, @auth_scheme, @extra_headers,
       @retry_attempts, @retry_interval_ms, @request_timeout_ms, @tls_verify,
       @enabled, @format, @endpoints, @native_conversion, @sort_order, @created_at, @updated_at)`,
  ).run({
    id,
    name: input.name,
    base_url: input.baseUrl.replace(/\/+$/, ""),
    host: input.host ?? null,
    api_keys: JSON.stringify(
      (input.apiKeys ?? []).filter((k) => k && k.length),
    ),
    auth_scheme: input.authScheme || "bearer",
    extra_headers: JSON.stringify(input.extraHeaders ?? {}),
    retry_attempts: input.retryAttempts ?? 1,
    retry_interval_ms: input.retryIntervalMs ?? 3000,
    request_timeout_ms: input.requestTimeoutMs ?? 600000,
    tls_verify: input.tlsVerify === false ? 0 : 1,
    enabled: input.enabled === false ? 0 : 1,
    format,
    endpoints: JSON.stringify(input.endpoints ?? defaultEndpoints(format)),
    native_conversion: input.nativeConversion ? 1 : 0,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  });
  return getProvider(db, id)!;
}

export function defaultEndpoints(format: ProviderFormat): string[] {
  return format === "anthropic" ? ["/v1/messages"] : ["/v1/chat/completions"];
}

export function updateProvider(
  db: DB,
  id: string,
  input: Partial<ProviderInput>,
): Provider | null {
  const existing = getProvider(db, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const format = input.format ?? existing.format;
  const next: ProviderInput = {
    name: input.name ?? existing.name,
    baseUrl: input.baseUrl ?? existing.baseUrl,
    host: input.host !== undefined ? input.host : existing.host,
    apiKeys: input.apiKeys ?? existing.apiKeys,
    authScheme: input.authScheme ?? existing.authScheme,
    extraHeaders: input.extraHeaders ?? existing.extraHeaders,
    retryAttempts: input.retryAttempts ?? existing.retryAttempts,
    retryIntervalMs: input.retryIntervalMs ?? existing.retryIntervalMs,
    requestTimeoutMs: input.requestTimeoutMs ?? existing.requestTimeoutMs,
    tlsVerify:
      input.tlsVerify !== undefined ? input.tlsVerify : existing.tlsVerify,
    enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
    format,
    endpoints:
      input.endpoints ??
      (input.format ? defaultEndpoints(format) : existing.endpoints),
    nativeConversion:
      input.nativeConversion !== undefined
        ? input.nativeConversion
        : existing.nativeConversion,
  };
  db.prepare(
    `UPDATE providers SET
       name=@name, base_url=@base_url, host=@host, api_keys=@api_keys,
       auth_scheme=@auth_scheme, extra_headers=@extra_headers,
       retry_attempts=@retry_attempts, retry_interval_ms=@retry_interval_ms,
       request_timeout_ms=@request_timeout_ms, tls_verify=@tls_verify,
       enabled=@enabled, format=@format, endpoints=@endpoints,
       native_conversion=@native_conversion, updated_at=@updated_at
     WHERE id=@id`,
  ).run({
    id,
    name: next.name,
    base_url: next.baseUrl!.replace(/\/+$/, ""),
    host: next.host ?? null,
    api_keys: JSON.stringify((next.apiKeys ?? []).filter((k) => k && k.length)),
    auth_scheme: next.authScheme || "bearer",
    extra_headers: JSON.stringify(next.extraHeaders ?? {}),
    retry_attempts: next.retryAttempts ?? 1,
    retry_interval_ms: next.retryIntervalMs ?? 3000,
    request_timeout_ms: next.requestTimeoutMs ?? 600000,
    tls_verify: next.tlsVerify === false ? 0 : 1,
    enabled: next.enabled === false ? 0 : 1,
    format,
    endpoints: JSON.stringify(next.endpoints ?? defaultEndpoints(format)),
    native_conversion: next.nativeConversion ? 1 : 0,
    updated_at: now,
  });
  return getProvider(db, id);
}

export function deleteProvider(db: DB, id: string): boolean {
  const r = db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  return r.changes > 0;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
