// Chat Completions response sanitization.
//
// Normalizes finish_reason to a valid OpenAI value and ensures the response
// has the required structural fields. Runs post-bridge when clientFmt is "chat".

import type { ChatCompletionResponse } from "../wire";

const VALID_FINISH_REASONS = new Set([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
]);

const FINISH_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  pause_turn: "stop",
  refusal: "content_filter",
  function_call: "tool_calls",
  completed: "stop",
  incomplete: "length",
};

export function sanitizeChatResponse(
  body: ChatCompletionResponse,
): ChatCompletionResponse {
  if (!body || typeof body !== "object") return body;

  if (!body.object) body.object = "chat.completion";

  const choices = body.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const fr = choice.finish_reason;
      if (typeof fr === "string" && !VALID_FINISH_REASONS.has(fr)) {
        choice.finish_reason = FINISH_REASON_MAP[fr] ?? "stop";
      }
      // Ensure tool_calls finish_reason when tool_calls are present.
      const msg = choice.message;
      if (
        msg &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0 &&
        choice.finish_reason !== "tool_calls"
      ) {
        choice.finish_reason = "tool_calls";
      }
    }
  }

  return body;
}
