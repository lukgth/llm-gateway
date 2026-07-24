// WebSocket message schema — the single source of truth for the typed
// protocol between the admin UI and the gateway server.

import type { TestProviderResult } from "../providers/base/types";

export type WsTopic =
  | "overview"
  | "usage"
  | "usage:breakdown"
  | "request-logs"
  | "providers"
  | "models"
  | "keys"
  | "users"
  | "settings";

export const WS_TOPICS: readonly WsTopic[] = [
  "overview",
  "usage",
  "usage:breakdown",
  "request-logs",
  "providers",
  "models",
  "keys",
  "users",
  "settings",
];

// ── Client → Server ─────────────────────────────────────────────────

export interface WsSubscribe {
  type: "subscribe";
  topic: WsTopic;
  params?: Record<string, string | number | boolean>;
}

export interface WsUnsubscribe {
  type: "unsubscribe";
  topic: WsTopic;
}

export interface WsRequest {
  type: "request";
  id: string;
  endpoint: string;
  params?: Record<string, string | number | boolean>;
}

export interface WsPong {
  type: "pong";
}

// Batch key testing — a parallel message family (not a WsTopic subscribe/
// push cycle, and not a one-shot `request`/`response`): the server streams
// one progress event per completed key as results land, in whatever order
// they finish, followed by a single terminal "done". `id` is caller-chosen
// (mirrors WsRequest) and scopes progress/done/error events to this one run;
// a client sends fresh unique ids for concurrent or repeated batches.
export interface WsBatchTest {
  type: "batch-test";
  id: string;
  providerId: string;
  keyIds: string[];
}

export type WsClientMessage =
  WsSubscribe | WsUnsubscribe | WsRequest | WsPong | WsBatchTest;

// ── Server → Client ─────────────────────────────────────────────────

export interface WsPush {
  type: "push";
  topic: WsTopic;
  data: unknown;
}

export interface WsResponse {
  type: "response";
  id: string;
  data?: unknown;
  error?: { message: string; code?: number };
}

export interface WsPing {
  type: "ping";
}

export interface WsInvalidate {
  type: "invalidate";
  topics: WsTopic[];
  source?: string;
}

export interface WsError {
  type: "error";
  message: string;
  code?: number;
}

// One per completed key, streamed as results land (not buffered until the
// whole batch finishes) — `index` is the key's position in the request's
// `keyIds` array, stable regardless of completion order, so the client can
// always match a result back to the request that produced it.
export interface WsBatchTestProgress {
  type: "batch-test-progress";
  id: string;
  index: number;
  keyId: string;
  result: TestProviderResult;
}

export interface WsBatchTestDone {
  type: "batch-test-done";
  id: string;
  total: number;
  ok: number;
}

// Fatal setup failure (unknown provider/key, duplicate batch id already
// running) — NOT an individual key's test failing, which is a normal
// `WsBatchTestProgress` with `result.ok === false`.
export interface WsBatchTestError {
  type: "batch-test-error";
  id: string;
  message: string;
}

export type WsServerMessage =
  | WsPush
  | WsResponse
  | WsPing
  | WsInvalidate
  | WsError
  | WsBatchTestProgress
  | WsBatchTestDone
  | WsBatchTestError;

// Push intervals for auto-refresh topics (ms). Topics not listed here
// push only on mutation (no timer).
export const PUSH_INTERVALS: Partial<Record<WsTopic, number>> = {
  overview: 15_000,
  "request-logs": 10_000,
  usage: 20_000,
  "usage:breakdown": 20_000,
};
