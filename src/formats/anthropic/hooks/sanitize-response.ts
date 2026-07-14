// Anthropic response field sanitization (response hook).
//
// Ensures every response returned to a Messages-format client contains ONLY
// valid Anthropic Messages API response fields. Non-Anthropic upstreams
// (OpenAI-compatible, GLM, etc.) may return fields like `stopReason`,
// `text`, `toolCalls`, `output`, etc. that survive the format bridge via
// the [k: string]: unknown index signature. This hook strips them so a
// Messages client never sees non-spec fields.
//
// Also normalises `stop_reason` to a valid Anthropic enum value and ensures
// the structural invariants (type: "message", role: "assistant", content is
// an array of valid blocks).
//
// Allowlist verified against https://platform.claude.com/docs/en/api/messages

import type { AnthropicMessagesResponse } from "../../pipeline";

const ALLOWED_RESPONSE = new Set([
  "id",
  "type",
  "role",
  "model",
  "content",
  "stop_reason",
  "stop_sequence",
  "stop_details",
  "usage",
  "container",
]);

const VALID_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

// Map non-Anthropic stop reasons to their Anthropic equivalents.
const STOP_REASON_MAP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

export function sanitizeAnthropicResponse(
  body: AnthropicMessagesResponse,
): AnthropicMessagesResponse {
  if (!body || typeof body !== "object") return body;

  if (body.type !== "message") body.type = "message";
  if (body.role !== "assistant") body.role = "assistant";

  const sr = body.stop_reason;
  if (typeof sr === "string") {
    if (!VALID_STOP_REASONS.has(sr)) {
      body.stop_reason = STOP_REASON_MAP[sr] ?? "end_turn";
    }
  } else {
    body.stop_reason = "end_turn";
  }

  if (!Array.isArray(body.content)) body.content = [];

  const ordered: Record<string, unknown> = {};
  for (const key of ALLOWED_RESPONSE) {
    if (key in body) ordered[key] = body[key as keyof typeof body];
  }
  return ordered as AnthropicMessagesResponse;
}
