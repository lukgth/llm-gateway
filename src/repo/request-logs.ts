// Request-log repository. One row per proxied request, feeding the dashboard's
// activity feed and overview stats. Logs are pruned to a configurable retention
// window so the table stays bounded.

import type { Database as DB } from "better-sqlite3";
import type { RequestLog } from "../shared/types";

interface LogRow {
  id: number;
  ts: string;
  api_key_id: string | null;
  api_key_name: string | null;
  user_id: string | null;
  model: string | null;
  provider_id: string | null;
  provider_name: string | null;
  upstream_model: string | null;
  status: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  client: string | null;
  path: string | null;
  stream: number;
  error: string | null;
}

function mapLog(r: LogRow): RequestLog {
  return {
    id: r.id,
    ts: r.ts,
    apiKeyId: r.api_key_id,
    apiKeyName: r.api_key_name,
    userId: r.user_id,
    model: r.model,
    providerId: r.provider_id,
    providerName: r.provider_name,
    upstreamModel: r.upstream_model,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    latencyMs: r.latency_ms,
    client: r.client,
    path: r.path,
    stream: !!r.stream,
    error: r.error,
  };
}

export interface InsertLogInput {
  apiKeyId: string | null;
  apiKeyName: string | null;
  userId: string | null;
  model: string | null;
  providerId: string | null;
  providerName: string | null;
  upstreamModel: string | null;
  status: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  client: string | null;
  path: string | null;
  stream: boolean;
  error: string | null;
}

export function insertRequestLog(db: DB, input: InsertLogInput): void {
  db.prepare(
    `INSERT INTO request_logs
      (ts, api_key_id, api_key_name, user_id, model, provider_id, provider_name,
       upstream_model, status, input_tokens, output_tokens, latency_ms, client, path, stream, error)
     VALUES (@ts, @api_key_id, @api_key_name, @user_id, @model, @provider_id, @provider_name,
       @upstream_model, @status, @input_tokens, @output_tokens, @latency_ms, @client, @path, @stream, @error)`,
  ).run({
    ts: new Date().toISOString(),
    api_key_id: input.apiKeyId,
    api_key_name: input.apiKeyName,
    user_id: input.userId,
    model: input.model,
    provider_id: input.providerId,
    provider_name: input.providerName,
    upstream_model: input.upstreamModel,
    status: input.status,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    latency_ms: input.latencyMs,
    client: input.client,
    path: input.path,
    stream: input.stream ? 1 : 0,
    error: input.error,
  });
}

export interface ListOpts {
  limit?: number;
  offset?: number;
  apiKeyId?: string;
  modelId?: string;
  providerId?: string;
  statusError?: boolean;
}

export function listRequestLogs(db: DB, opts: ListOpts = {}): RequestLog[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.apiKeyId) {
    conditions.push("api_key_id = @apiKeyId");
    params.apiKeyId = opts.apiKeyId;
  }
  if (opts.modelId) {
    conditions.push("model = @modelId");
    params.modelId = opts.modelId;
  }
  if (opts.providerId) {
    conditions.push("provider_id = @providerId");
    params.providerId = opts.providerId;
  }
  if (opts.statusError) {
    conditions.push("(status IS NULL OR status >= 400)");
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.limit = opts.limit ?? 100;
  params.offset = opts.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as LogRow[];
  return rows.map(mapLog);
}

export function countRequestLogs(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM request_logs").get() as {
    c: number;
  };
  return row.c;
}

export function pruneOldLogs(db: DB, retentionDays: number): number {
  const r = db
    .prepare("DELETE FROM request_logs WHERE ts < date('now', ?)")
    .run(`-${retentionDays} days`);
  return r.changes;
}

// --- Aggregated dashboard stats -------------------------------------------

export interface DashboardStats {
  requestsToday: number;
  requestsErrorToday: number;
  tokensToday: number;
  errorRateToday: number;
  byModel: Array<{ model: string; requests: number; tokens: number }>;
  byProvider: Array<{
    providerId: string;
    provider: string;
    requests: number;
    tokens: number;
  }>;
  statusBands: { success: number; clientError: number; serverError: number };
  p95LatencyMs: number | null;
}

export function dashboardStats(db: DB): DashboardStats {
  const today = new Date().toISOString().slice(0, 10);
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) AS requests,
         COALESCE(SUM(CASE WHEN status IS NULL OR status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens,
         COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END), 0) AS clientErr,
         COALESCE(SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END), 0) AS serverErr
       FROM request_logs WHERE date(ts) = @today`,
    )
    .get({ today }) as {
    requests: number;
    errors: number;
    tokens: number;
    success: number;
    clientErr: number;
    serverErr: number;
  };

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS requests,
         COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens
       FROM request_logs WHERE date(ts) = @today AND model IS NOT NULL
       GROUP BY model ORDER BY requests DESC LIMIT 10`,
    )
    .all({ today }) as Array<{
    model: string;
    requests: number;
    tokens: number;
  }>;

  const byProvider = db
    .prepare(
      `SELECT provider_id AS providerId, provider_name AS provider,
         COUNT(*) AS requests,
         COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens
       FROM request_logs WHERE date(ts) = @today AND provider_id IS NOT NULL
       GROUP BY provider_id ORDER BY requests DESC LIMIT 10`,
    )
    .all({ today }) as Array<{
    providerId: string;
    provider: string;
    requests: number;
    tokens: number;
  }>;

  const p95Row = db
    .prepare(
      `SELECT latency_ms FROM request_logs
       WHERE date(ts) = @today AND latency_ms IS NOT NULL
       ORDER BY latency_ms`,
    )
    .all({ today }) as Array<{ latency_ms: number }>;
  let p95: number | null = null;
  if (p95Row.length) {
    // Nearest-rank p95: ceil(N * 0.95) as a 1-based rank -> 0-based index.
    const idx = Math.max(0, Math.ceil(p95Row.length * 0.95) - 1);
    p95 = p95Row[idx].latency_ms;
  }

  const req = agg.requests || 0;
  return {
    requestsToday: req,
    requestsErrorToday: agg.errors || 0,
    tokensToday: agg.tokens || 0,
    errorRateToday: req ? (agg.errors / req) * 100 : 0,
    byModel,
    byProvider,
    statusBands: {
      success: agg.success || 0,
      clientError: agg.clientErr || 0,
      serverError: agg.serverErr || 0,
    },
    p95LatencyMs: p95,
  };
}
