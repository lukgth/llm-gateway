// Request-side PII redaction.
//
// Walks CONVERSATION CONTENT and nothing else: message text, thinking, tool
// RESULTS (where a command's output, a file read, or an API response can carry a
// secret), and tool-call ARGUMENTS. Every span Presidio detects is replaced with
// a placeholder token; the response-side re-hydrator puts the originals back.
//
// Deliberately NOT redacted:
//   - the SYSTEM PROMPT (`system` / `instructions`, and system/developer-role
//     messages) - operator-authored, not user data;
//   - TOOL DEFINITIONS (`tools` / `functions`) - names, descriptions and schemas
//     are authored by the operator or the client, and mangling one would break
//     tool calling for a model that can no longer match its own schema;
//   - structural keys (model, tool_choice, response_format, metadata, …).
//
// The span list comes from ONE analyzer request for the whole body; the token
// map it returns is what the response-side re-hydrator resolves against.

import type { Json } from "../formats/pipeline";
import { analyzeTexts, type PiiConfig, type PiiSpan } from "./analyzer";
import { jsonEscape, piiToken } from "./tokens";

interface StrSlot {
  owner: Record<string, unknown> | unknown[];
  key: string | number;
  value: string; // decoded
}

function writeSlot(slot: StrSlot, value: string): void {
  if (Array.isArray(slot.owner)) slot.owner[slot.key as number] = value;
  else slot.owner[slot.key as string] = value;
}

// Real Presidio output contains OVERLAPPING spans: an address like
// "ada@example.com" comes back as EMAIL_ADDRESS 31-46 *and* URL 35-46. Splitting
// at overlapping offsets would both mangle a token (the later splice cuts into
// the earlier token's bytes) and leave the uncovered part of the original
// visible - a partial PII leak. So genuine overlaps are MERGED into their union,
// named by the widest member (ties → higher score, then the earlier span).
// Merging favors coverage over precision, which is the right bias for a
// redaction pass; an untouched neighbour string never overlaps an entity.
function mergeOverlapping(spans: PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: PiiSpan[] = [];
  for (const span of sorted) {
    const prev = out[out.length - 1];
    if (!prev || span.start >= prev.end) {
      out.push({ ...span });
      continue;
    }
    const width = span.end - span.start;
    const prevWidth = prev.end - prev.start;
    const wins = width > prevWidth || (width === prevWidth && span.score > prev.score);
    prev.end = Math.max(prev.end, span.end);
    if (wins) {
      prev.entity_type = span.entity_type;
      prev.score = span.score;
    }
  }
  return out;
}

/** Conversation-content strings only, in the wire shape. */
function collectContentStrings(body: Json): {
  slots: StrSlot[];
  finalize: () => void;
} {
  const slots: StrSlot[] = [];
  // Tool arguments arrive as a JSON *string*; they are walked as structure and
  // re-stringified in `finalize()`, so the wire field stays valid JSON.
  const jsonFields: Array<{
    owner: Record<string, unknown>;
    key: string;
    parsed: unknown;
  }> = [];

  const push = (owner: StrSlot["owner"], key: string | number, value: unknown) => {
    if (typeof value === "string") slots.push({ owner, key, value });
  };

  // Recursive all-strings walk (tool_use input, parsed tool arguments).
  const collectDeep = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) =>
        typeof v === "string" ? push(node, i, v) : collectDeep(v),
      );
      return;
    }
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      typeof v === "string" ? push(rec, key, v) : collectDeep(v);
    }
  };

  const collectJsonField = (
    owner: Record<string, unknown>,
    key: string,
  ): void => {
    const raw = owner[key];
    if (typeof raw !== "string") return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        collectDeep(parsed);
        jsonFields.push({ owner, key, parsed });
      } else {
        push(owner, key, raw);
      }
    } catch {
      // Not JSON - treat the raw string as one text slot.
      push(owner, key, raw);
    }
  };

  const collectBlock = (block: unknown): void => {
    if (!block || typeof block !== "object") return;
    const b = block as Record<string, unknown>;
    switch (typeof b.type === "string" ? b.type : "") {
      case "text":
      case "input_text":
      case "output_text":
        push(b, "text", b.text);
        return;
      case "thinking":
        push(b, "thinking", b.thinking);
        return;
      case "tool_result": {
        const content = b.content;
        if (typeof content === "string") push(b, "content", content);
        else if (Array.isArray(content))
          for (const sub of content)
            if (sub && typeof sub === "object")
              push(sub as Record<string, unknown>, "text", (sub as Record<string, unknown>).text);
        return;
      }
      case "tool_use":
        collectDeep(b.input);
        return;
      case "function_call":
        collectJsonField(b, "arguments");
        return;
      default:
        return;
    }
  };

  // --- chat / messages: messages[] ---
  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      if (!raw || typeof raw !== "object") continue;
      const msg = raw as Record<string, unknown>;
      // The system prompt is the operator's own text - never redacted.
      if (msg.role === "system" || msg.role === "developer") continue;
      if (typeof msg.content === "string") push(msg, "content", msg.content);
      else if (Array.isArray(msg.content))
        for (const block of msg.content) collectBlock(block);
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call || typeof call !== "object") continue;
          const fn = (call as Record<string, unknown>).function;
          if (fn && typeof fn === "object")
            collectJsonField(fn as Record<string, unknown>, "arguments");
        }
      }
    }
  }

  // --- responses: input[] ---
  if (Array.isArray(body.input)) {
    body.input.forEach((item, i) => {
      if (typeof item === "string") {
        // A bare string item is user-supplied input, not the system prompt.
        slots.push({ owner: body.input as unknown[], key: i, value: item });
        return;
      }
      if (!item || typeof item !== "object") return;
      const it = item as Record<string, unknown>;
      // Responses carries its system prompt as a developer/system-role input
      // item - same rule as a chat system message: left alone.
      if (it.role === "system" || it.role === "developer") return;
      if (typeof it.content === "string") push(it, "content", it.content);
      else if (Array.isArray(it.content))
        for (const block of it.content) collectBlock(block);
      if (it.type === "function_call") collectJsonField(it, "arguments");
      // A tool's OUTPUT - the Responses twin of an Anthropic tool_result, and
      // the likeliest place for a command's output to carry a secret.
      if (it.type === "function_call_output") {
        const output = it.output;
        if (typeof output === "string") push(it, "output", output);
        else if (Array.isArray(output))
          for (const block of output) collectBlock(block);
      }
    });
  }

  return {
    slots,
    finalize: () => {
      for (const f of jsonFields) f.owner[f.key] = JSON.stringify(f.parsed);
    },
  };
}

/** Mutates `body` in place, replacing every detected span with a token.
 *  Returns the token → JSON-escaped-original map (empty when nothing matched). */
export async function redactBody(
  body: Json,
  cfg: PiiConfig,
): Promise<Map<string, string>> {
  const { slots, finalize } = collectContentStrings(body);
  if (slots.length === 0) return new Map();

  // One HTTP call for the whole request. Any throw propagates: the engine turns
  // it into a hop skip, so nothing unredacted can reach that provider.
  const spans = await analyzeTexts(
    cfg,
    slots.map((s) => s.value),
  );

  const map = new Map<string, string>();
  const byText = new Map<string, string>();
  let n = 0;

  slots.forEach((slot, i) => {
    // Number tokens in document order (readable in the debug log), but splice
    // from the end backwards so earlier offsets stay valid.
    const list = mergeOverlapping(
      [...(spans[i] ?? [])].filter(
        (s) =>
          Number.isInteger(s.start) &&
          Number.isInteger(s.end) &&
          s.start >= 0 &&
          s.start < s.end &&
          s.end <= slot.value.length,
      ),
    );
    let value = slot.value;
    // Pass 1 (ascending): mint/dedupe tokens in document order.
    const assigned = list.map((s) => {
      const type = s.entity_type || "UNKNOWN";
      const raw = slot.value.slice(s.start, s.end);
      // Reuse an identical (type, value) pair: smaller prompt, more consistent echo.
      const key = `${type}\u0000${raw}`;
      let token = byText.get(key);
      if (token === undefined) {
        token = piiToken(type, ++n);
        byText.set(key, token);
      }
      map.set(token, jsonEscape(raw));
      return { start: s.start, end: s.end, token };
    });
    // Pass 2 (descending): splice, so earlier offsets stay valid.
    for (let k = assigned.length - 1; k >= 0; k--) {
      const { start, end, token } = assigned[k];
      value = value.slice(0, start) + token + value.slice(end);
    }
    if (value !== slot.value) writeSlot(slot, value);
  });

  finalize();
  return map;
}
