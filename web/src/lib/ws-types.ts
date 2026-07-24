import type { ProviderTestResult } from "./types";

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

// Batch key testing — mirrors src/ws/schema.ts's WsBatchTest. A parallel
// message family (not a topic subscribe/push, not a one-shot request):
// the server streams one progress event per completed key, in whatever
// order they finish, followed by a single terminal "done".
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
  error?: string;
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

// One per completed key, streamed as results land — `index` is the key's
// position in the request's `keyIds` array, stable regardless of
// completion order.
export interface WsBatchTestProgress {
  type: "batch-test-progress";
  id: string;
  index: number;
  keyId: string;
  result: ProviderTestResult;
}

export interface WsBatchTestDone {
  type: "batch-test-done";
  id: string;
  total: number;
  ok: number;
}

// Fatal setup failure (unknown provider/key, duplicate batch id already
// running) — NOT an individual key's test failing (that's a normal
// WsBatchTestProgress with result.ok === false).
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
