// Token counting for request bodies and response usage extraction.
//
// Used by the gateway's context-window enforcement and per-key usage-limit
// middleware. Uses a coarse chars/4 heuristic - imprecise per-request but
// stable across every model the gateway serves, and accurate enough in
// aggregate for quota enforcement. Exact token counts reported by the
// upstream (when available) are reconciled after the response arrives; see
// reconcileUsage() in gateway/engine.ts.
//
// All public functions are synchronous and safe to call from request
// middleware. Counting never throws.

// Count tokens in a plain string. ~4 chars/token heuristic.
export function countTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Approximate per-message overhead in tokens (role tag, separators, etc.).
// The exact value varies by model but ~4 is a fine rule-of-thumb.
const PER_MSG_OVERHEAD = 4;

// Count tokens in a message `content` field across all shapes the gateway
// sees. Content may be:
//   - plain string
//   - array of { type:'text', text }                    (OpenAI/Anthropic)
//   - array of { type:'input_text'|'output_text', text } (Responses)
//   - array of { type:'tool_use', input }               (Anthropic)
//   - array of { type:'tool_result', content }          (Anthropic)
//   - array of { type:'image_url', image_url:{url} }    (OpenAI vision)
//   - any unknown shape - falls back to JSON.stringify
function countContent(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return countTextTokens(content);
  if (!Array.isArray(content)) return countTextTokens(JSON.stringify(content));
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      total += countTextTokens(String(part ?? ""));
      continue;
    }
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") {
      total += countTextTokens(p.text);
    } else if (typeof p.input === "string") {
      // Anthropic tool_use.input is often an object; count its serialised form.
      total += countTextTokens(p.input);
    } else if (typeof p.input === "object" && p.input !== null) {
      total += countTextTokens(JSON.stringify(p.input));
    } else if (p.content != null) {
      // Anthropic tool_result.content can itself be a string or array of parts.
      total += countContent(p.content);
    } else {
      // Unknown part (image url, file, etc.) - count its JSON form so we
      // don't silently drop non-text payloads from the tally.
      total += countTextTokens(JSON.stringify(p));
    }
  }
  return total;
}

// Count input tokens in an Anthropic /v1/messages body.
// Includes: system, all messages, and tool definitions.
function countAnthropicBody(body: Record<string, unknown>): number {
  let total = 0;
  if (body.system != null) total += countContent(body.system);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      total +=
        PER_MSG_OVERHEAD + countContent((m as Record<string, unknown>).content);
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) total += countTextTokens(JSON.stringify(t));
  }
  return total;
}

// Count input tokens in an OpenAI /v1/chat/completions body.
// Includes: messages, tool_calls on messages, and tool definitions.
function countChatBody(body: Record<string, unknown>): number {
  let total = 0;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      total += PER_MSG_OVERHEAD + countContent(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls)
          total += countTextTokens(JSON.stringify(tc));
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) total += countTextTokens(JSON.stringify(t));
  }
  return total;
}

// Count input tokens in an OpenAI /v1/responses body (pre-bridge shape).
// Includes: instructions, input (string or items), and tool definitions.
function countResponsesBody(body: Record<string, unknown>): number {
  let total = 0;
  if (typeof body.instructions === "string")
    total += countTextTokens(body.instructions);
  if (typeof body.input === "string") {
    total += PER_MSG_OVERHEAD + countTextTokens(body.input);
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.content != null)
        total += PER_MSG_OVERHEAD + countContent(it.content);
      else if (typeof it.arguments === "string")
        total += PER_MSG_OVERHEAD + countTextTokens(it.arguments);
      else if (it.output != null)
        total += PER_MSG_OVERHEAD + countContent(it.output);
      else total += PER_MSG_OVERHEAD;
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) total += countTextTokens(JSON.stringify(t));
  }
  return total;
}

// Count input tokens in a request body, picking the right algorithm from
// the request path. Returns 0 for unrecognised paths or non-object bodies.
// Never throws.
export function countInputTokens(body: unknown, path: string): number {
  if (!body || typeof body !== "object") return 0;
  const p = path.split("?")[0];
  try {
    if (p.endsWith("/messages"))
      return countAnthropicBody(body as Record<string, unknown>);
    if (p.endsWith("/chat/completions"))
      return countChatBody(body as Record<string, unknown>);
    if (p.endsWith("/responses"))
      return countResponsesBody(body as Record<string, unknown>);
  } catch {
    return 0;
  }
  return 0;
}

// Read the requested max output tokens from a request body across shapes.
// Returns undefined when the request didn't specify one (caller falls back
// to the model's maxOutputTokens).
export function readMaxOutputTokens(
  body: Record<string, unknown>,
): number | undefined {
  const m = body as {
    max_tokens?: number;
    max_completion_tokens?: number;
    max_output_tokens?: number;
  };
  if (typeof m.max_tokens === "number") return m.max_tokens;
  if (typeof m.max_completion_tokens === "number")
    return m.max_completion_tokens;
  if (typeof m.max_output_tokens === "number") return m.max_output_tokens;
  return undefined;
}

export interface NormalizedUsage {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
}

// Extract upstream-reported token usage from a parsed response body.
// Returns {} when no usage info is present (e.g. passthrough / streaming).
export function readResponseUsage(body: unknown): NormalizedUsage {
  if (!body || typeof body !== "object" || !("usage" in body)) return {};
  return normalizeUsage(body.usage);
}

// Normalize one provider usage object for buffered and streaming responses.
// `input` is the TOTAL input tokens including cached - the same convention
// OpenAI's `prompt_tokens` uses. Anthropic reports cache buckets separately
// (cache_read_input_tokens / cache_creation_input_tokens) and its
// `input_tokens` excludes them, so this function adds them back to normalise
// to one convention.
//
// `cached` is the subset of `input` that were prompt-cache hits (reads),
// `cacheWrite` the subset that were prompt-cache writes/creations, surfaced
// separately for cost visibility. `computeCostUsd` subtracts both from `input`
// to derive the uncached billable portion - so `input` MUST include both
// buckets or the subtraction double-counts.
export function normalizeUsage(usage: unknown): NormalizedUsage {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const o = usage as Record<string, unknown>;
  const out: NormalizedUsage = {};
  // Prefer Responses/Anthropic fields over Chat, and native Gemini fields
  // when present. Invalid counts are absent, not authoritative zeroes.
  const anthropicInput = numOrNull(o.input_tokens);
  const geminiInput = numOrNull(o.promptTokenCount);
  const input = geminiInput ?? anthropicInput ?? numOrNull(o.prompt_tokens);
  const output =
    numOrNull(o.candidatesTokenCount) ??
    numOrNull(o.output_tokens) ??
    numOrNull(o.completion_tokens);
  if (input != null) out.input = input;
  if (output != null) out.output = output;
  const total = numOrNull(o.totalTokenCount);
  if (total != null && out.input === undefined) {
    const rest = total - (out.output ?? 0);
    if (rest >= 0) out.input = rest;
  }
  const cached = readCachedTokens(o);
  if (cached != null) {
    out.cached = cached;
  }
  const cacheWrite = readCacheWriteTokens(o);
  if (cacheWrite != null) {
    out.cacheWrite = cacheWrite;
  }
  // Anthropic's input_tokens excludes cache buckets. Normalise so `input`
  // always means "total input including cached" (the convention
  // computeCostUsd expects). For OpenAI, prompt_tokens already includes
  // both buckets, so only add when detecting the Anthropic shape.
  if (anthropicInput != null && geminiInput == null) {
    const read = numOrNull(o.cache_read_input_tokens) ?? 0;
    const write = numOrNull(o.cache_creation_input_tokens) ?? 0;
    out.input = anthropicInput + read + write;
  }
  return out;
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
}

// Pull cached (prompt-cache-hit) input tokens from a usage object across the
// shapes. Returns null when the field isn't present. Negative or non-numeric
// values are treated as absent.
export function readCachedTokens(o: Record<string, unknown>): number | null {
  // Anthropic: usage.cache_read_input_tokens
  const anthropic = numOrNull(o.cache_read_input_tokens);
  if (anthropic != null) return anthropic;
  // Gemini native: usage.cachedContentTokenCount
  const gemini = numOrNull(o.cachedContentTokenCount);
  if (gemini != null) return gemini;
  // OpenAI Chat/Responses: usage.prompt_tokens_details.cached_tokens
  const details = o.prompt_tokens_details ?? o.input_tokens_details;
  if (details && typeof details === "object" && "cached_tokens" in details) {
    const nested = numOrNull(details.cached_tokens);
    if (nested != null) return nested;
  }
  return null;
}

// Pull cache-write (creation) input tokens from a usage object across the
// shapes. Returns null when the field isn't present. Negative or non-numeric
// values are treated as absent.
export function readCacheWriteTokens(
  o: Record<string, unknown>,
): number | null {
  // Anthropic: usage.cache_creation_input_tokens. OpenAI-compatible gateways
  // (Cline) also report a top-level usage.cache_write_tokens.
  const topLevel = numOrNull(
    o.cache_creation_input_tokens ?? o.cache_write_tokens,
  );
  if (topLevel != null) return topLevel;
  // Nested OpenAI details: prompt_tokens_details.cache_write_tokens (and the
  // legacy cache_creation_tokens variant the chat->messages bridge reads).
  const details = o.prompt_tokens_details ?? o.input_tokens_details;
  if (details && typeof details === "object") {
    if ("cache_write_tokens" in details) {
      const nested = numOrNull(details.cache_write_tokens);
      if (nested != null) return nested;
    }
    if ("cache_creation_tokens" in details) {
      const legacy = numOrNull(details.cache_creation_tokens);
      if (legacy != null) return legacy;
    }
  }
  return null;
}
