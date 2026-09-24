import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyUpstreamResponseReason } from "./empty-response";

// --- chat (OpenAI Chat Completions) -----------------------------------------

test("chat: an explicit empty choices array is empty", () => {
  assert.match(
    emptyUpstreamResponseReason("chat", { choices: [] })!,
    /empty choices/,
  );
});

test("chat: a MISSING choices field is NOT flagged (field absent != field empty)", () => {
  // A body that never uses `choices` at all (a minimal/diagnostic-only test
  // fixture, a non-standard endpoint) must not be misclassified as a dead
  // account just because this check doesn't recognize its shape.
  assert.equal(emptyUpstreamResponseReason("chat", {}), undefined);
  assert.equal(
    emptyUpstreamResponseReason("chat", { id: "x", usage: {} }),
    undefined,
  );
});

test("chat: a choice with real text content is NOT empty", () => {
  assert.equal(
    emptyUpstreamResponseReason("chat", {
      choices: [
        {
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    }),
    undefined,
  );
});

test("chat: a choice with only whitespace content IS empty", () => {
  assert.match(
    emptyUpstreamResponseReason("chat", {
      choices: [
        {
          message: { role: "assistant", content: "   " },
          finish_reason: "stop",
        },
      ],
    })!,
    /no content/,
  );
});

test("chat: a choice with a tool call and no text is NOT empty", () => {
  assert.equal(
    emptyUpstreamResponseReason("chat", {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "1",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    undefined,
  );
});

test("chat: a choice with only a refusal is NOT empty (a refusal is a real answer)", () => {
  assert.equal(
    emptyUpstreamResponseReason("chat", {
      choices: [
        {
          message: {
            role: "assistant",
            refusal: "I can't help with that.",
            content: null,
          },
          finish_reason: "stop",
        },
      ],
    }),
    undefined,
  );
});

test("chat: reasoning-only content (no answer, no refusal, no tool call) IS empty", () => {
  assert.match(
    emptyUpstreamResponseReason("chat", {
      choices: [
        {
          message: {
            role: "assistant",
            reasoning_content: "thinking...",
            content: null,
          },
          finish_reason: "stop",
        },
      ],
    })!,
    /no content/,
  );
});

test("chat: at least one choice with content among several is NOT empty", () => {
  assert.equal(
    emptyUpstreamResponseReason("chat", {
      choices: [
        {
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
        {
          message: { role: "assistant", content: "real answer" },
          finish_reason: "stop",
        },
      ],
    }),
    undefined,
  );
});

// --- responses (OpenAI Responses API) ---------------------------------------

test("responses: an explicit empty output array is empty", () => {
  assert.match(
    emptyUpstreamResponseReason("responses", { output: [] })!,
    /empty output/,
  );
});

test("responses: a MISSING output field is NOT flagged", () => {
  assert.equal(emptyUpstreamResponseReason("responses", {}), undefined);
});

test("responses: an output_text item is NOT empty", () => {
  assert.equal(
    emptyUpstreamResponseReason("responses", {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    }),
    undefined,
  );
});

test("responses: a refusal content item is NOT empty", () => {
  assert.equal(
    emptyUpstreamResponseReason("responses", {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I can't help with that." }],
        },
      ],
    }),
    undefined,
  );
});

test("responses: a function_call output item is NOT empty", () => {
  assert.equal(
    emptyUpstreamResponseReason("responses", {
      output: [
        { type: "function_call", name: "f", arguments: "{}", call_id: "1" },
      ],
    }),
    undefined,
  );
});

test("responses: a message item with an explicit empty content array IS empty", () => {
  assert.match(
    emptyUpstreamResponseReason("responses", {
      output: [{ type: "message", role: "assistant", content: [] }],
    })!,
    /no content/,
  );
});

// --- messages (Anthropic) - deliberately NOT covered by this detector ------
// See the module doc comment: unlike the confirmed OpenAI-compatible "empty
// 200" pattern, there's no equivalent confirmed report for Anthropic, and a
// prior attempt to cover it defensively broke a real Claude Code test
// fixture that legitimately uses `content: []`. Anthropic account/key
// failures surface via a real non-2xx status instead (usage-credits.ts).

test("messages: never flagged, even for an explicit empty content array", () => {
  assert.equal(
    emptyUpstreamResponseReason("messages", { content: [] }),
    undefined,
  );
  assert.equal(emptyUpstreamResponseReason("messages", {}), undefined);
  assert.equal(
    emptyUpstreamResponseReason("messages", {
      content: [{ type: "thinking", thinking: "..." }],
    }),
    undefined,
  );
  assert.equal(
    emptyUpstreamResponseReason("messages", {
      content: [{ type: "text", text: "hello" }],
    }),
    undefined,
  );
});

// --- non-object / non-array-field bodies -------------------------------------

test("a non-object body is never flagged (nothing to inspect)", () => {
  assert.equal(emptyUpstreamResponseReason("chat", null), undefined);
  assert.equal(emptyUpstreamResponseReason("chat", "just a string"), undefined);
  assert.equal(emptyUpstreamResponseReason("chat", []), undefined);
  assert.equal(emptyUpstreamResponseReason("responses", undefined), undefined);
});

test("a non-array choices/output/content field is treated as absent, not empty", () => {
  assert.equal(
    emptyUpstreamResponseReason("chat", { choices: null }),
    undefined,
  );
  assert.equal(
    emptyUpstreamResponseReason("chat", { choices: "not an array" }),
    undefined,
  );
  assert.equal(
    emptyUpstreamResponseReason("responses", { output: null }),
    undefined,
  );
  assert.equal(
    emptyUpstreamResponseReason("messages", { content: null }),
    undefined,
  );
});
