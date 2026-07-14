// Anthropic max_tokens ceiling clamp (request hook).
//
// Anthropic requires `max_tokens`, and a request whose max_tokens exceeds the
// model's real output ceiling is wasteful (and some upstreams 400). We clamp to
// the hop's effective ceiling — which comes from OUR OWN config
// (link ?? imported-model ?? exposed-model), threaded in via
// TransformCtx.maxOutputTokens — not a hardcoded per-model table.
//
// Ordering note: this runs BEFORE thinking-config (which gets the final say
// and may raise max_tokens to accommodate budget_tokens). If the ceiling
// would clamp below an existing budget, we shrink the budget so the request
// stays valid (Anthropic requires max_tokens > budget_tokens).

import type {
  AnthropicMessagesRequest,
  AnthropicThinkingConfig,
} from "../../pipeline";

const MIN_BUDGET = 1024;

// Clamp body.max_tokens to `ceiling` (when set and positive), preserving the
// Anthropic invariant max_tokens > thinking.budget_tokens. Mutates + returns.
export function clampMaxTokens(
  body: AnthropicMessagesRequest,
  ceiling: number | null | undefined,
): AnthropicMessagesRequest {
  if (!body || typeof body !== "object") return body;
  if (typeof ceiling !== "number" || ceiling <= 0) return body;
  const cur = body.max_tokens;
  if (typeof cur !== "number" || cur <= ceiling) return body;

  body.max_tokens = ceiling;

  const t = body.thinking as AnthropicThinkingConfig | undefined;
  if (
    t &&
    t.type === "enabled" &&
    typeof t.budget_tokens === "number" &&
    t.budget_tokens >= ceiling
  ) {
    t.budget_tokens = Math.max(MIN_BUDGET, ceiling - MIN_BUDGET);
  }
  return body;
}
