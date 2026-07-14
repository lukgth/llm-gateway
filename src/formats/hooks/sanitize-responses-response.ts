// Responses API response sanitization.
//
// Normalizes the `status` field to a valid OpenAI Responses value and ensures
// structural consistency. Runs post-bridge when clientFmt is "responses".

import type { ResponsesResponse } from "../wire";

const VALID_STATUSES = new Set([
  "completed",
  "incomplete",
  "in_progress",
  "failed",
  "cancelled",
]);

const STATUS_MAP: Record<string, string> = {
  end_turn: "completed",
  stop: "completed",
  max_tokens: "incomplete",
  length: "incomplete",
  tool_use: "completed",
  tool_calls: "completed",
  content_filter: "incomplete",
};

export function sanitizeResponsesResponse(
  body: ResponsesResponse,
): ResponsesResponse {
  if (!body || typeof body !== "object") return body;

  if (!body.object) body.object = "response";

  const s = body.status;
  if (typeof s === "string" && !VALID_STATUSES.has(s)) {
    body.status = STATUS_MAP[s] ?? "completed";
  }

  return body;
}
