// Detects a 2xx upstream response that EXPLICITLY reports zero content - an
// empty `choices`/`output` ARRAY, or an array whose only entries have
// neither text, a refusal, nor a tool call - for OpenAI Chat and OpenAI
// Responses format bodies. A dead/invalid/empty upstream account commonly
// answers this way (HTTP 200, `{"choices": []}`) instead of a 4xx, because
// the account is fine at the transport level - it just has nothing to say.
//
// Deliberately conservative in the other direction too: a body that omits
// the field ENTIRELY (no `choices` key at all, say) is NOT treated as
// empty - only an explicit empty/content-less array is. Plenty of legitimate
// non-conversational or diagnostic-only upstream responses, custom
// mock/test servers, and partial/non-standard OpenAI-compatible endpoints
// never include the field at all while still being perfectly fine
// responses; treating "field absent" the same as "field empty" would
// misclassify all of those as dead accounts.
//
// Anthropic Messages format is intentionally NOT covered here at all (not
// even defensively): unlike the confirmed OpenAI-compatible "empty 200"
// pattern this detector targets, there's no equivalent confirmed report for
// Anthropic - its account/key failures normally surface via a real non-2xx
// status (see usage-credits.ts's detectors), and a legitimate Anthropic
// response can have an empty `content: []` for reasons unrelated to a dead
// account (e.g. a max_tokens:0 probe). Speculatively extending this check
// to messages once regressed a real Claude Code test fixture that used
// exactly that shape - see git history if tempted to re-add it.

import type { Fmt } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// A Chat/Responses message/output entry counts as "has content" if it has
// non-empty text, a refusal (a refusal IS a real answer, just a declined
// one - never treated as empty), a tool/function call, or any other
// recognized content-bearing field. Reasoning-only entries do NOT count -
// vendors always pair reasoning with either an answer or a refusal, so a
// reasoning-only choice is the same "nothing came back" signal as a wholly
// empty one.
function chatChoiceHasContent(choice: unknown): boolean {
  const c = record(choice);
  if (!c) return false;
  // Buffered (non-streaming) responses only - a choice always carries
  // `message`, never `delta` (that's the streaming-chunk shape).
  const msg = record(c.message);
  if (!msg) return false;
  if (typeof msg.refusal === "string" && msg.refusal.trim()) return true;
  if (typeof msg.content === "string" && msg.content.trim()) return true;
  if (Array.isArray(msg.content) && msg.content.length > 0) return true;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  if (typeof msg.function_call === "object" && msg.function_call) return true;
  return false;
}

function responsesOutputHasContent(item: unknown): boolean {
  const o = record(item);
  if (!o) return false;
  // Function/tool call items ride at the top level of `output[]`, not
  // nested under `content` (Responses API shape) - a call IS content.
  if (
    o.type === "function_call" ||
    o.type === "tool_call" ||
    o.type === "web_search_call" ||
    o.type === "computer_call"
  )
    return true;
  const content = o.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some((part) => {
    const p = record(part);
    if (!p) return false;
    if (p.type === "refusal" && typeof p.refusal === "string" && p.refusal.trim())
      return true;
    if (
      (p.type === "output_text" || p.type === "text") &&
      typeof p.text === "string" &&
      p.text.trim()
    )
      return true;
    return false;
  });
}

// Returns a short reason string when `body` EXPLICITLY reports empty content
// for its format, or `undefined` when it has real content, a legitimate
// refusal, or simply doesn't use the field this check looks at (in which
// case there's nothing to flag - see the module doc comment on why "absent"
// is never treated as "empty").
export function emptyUpstreamResponseReason(
  fmt: Fmt,
  body: unknown,
): string | undefined {
  const b = record(body);
  if (!b) return undefined;

  if (fmt === "chat") {
    const choices = b.choices;
    if (!Array.isArray(choices)) return undefined;
    if (choices.length === 0) return "upstream returned an empty choices array";
    if (choices.every((c) => !chatChoiceHasContent(c)))
      return "upstream choice(s) had no content, refusal, or tool call";
    return undefined;
  }

  if (fmt === "responses") {
    const output = b.output;
    if (!Array.isArray(output)) return undefined;
    if (output.length === 0) return "upstream returned an empty output array";
    if (output.every((o) => !responsesOutputHasContent(o)))
      return "upstream output item(s) had no content, refusal, or tool call";
    return undefined;
  }

  // messages (Anthropic) - not covered, see module doc comment.
  return undefined;
}
