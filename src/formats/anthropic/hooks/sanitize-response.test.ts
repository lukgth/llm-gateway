// Anthropic response field sanitization tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAnthropicResponse } from "./sanitize-response";

test("sanitize-response: strips non-Anthropic fields from a GLM-shaped response", () => {
  const body = sanitizeAnthropicResponse({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-5.2",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    stopReason: "tool_calls",
    text: "some text",
    toolCalls: [{ name: "fn", arguments: "{}" }],
    output: [{ type: "message" }],
  });
  assert.equal(body.id, "msg_1");
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.stopReason, undefined);
  assert.equal(body.text, undefined);
  assert.equal(body.toolCalls, undefined);
  assert.equal(body.output, undefined);
});

test("sanitize-response: normalizes missing type and role", () => {
  const body = sanitizeAnthropicResponse({
    id: "msg_1",
    content: [],
    stop_reason: "end_turn",
    usage: {},
  });
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
});

test("sanitize-response: maps OpenAI stop reasons to Anthropic equivalents", () => {
  const map: Record<string, string> = {
    tool_calls: "tool_use",
    function_call: "tool_use",
    stop: "end_turn",
    length: "max_tokens",
    content_filter: "end_turn",
  };
  for (const [input, expected] of Object.entries(map)) {
    const body = sanitizeAnthropicResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: input,
      usage: {},
    });
    assert.equal(body.stop_reason, expected, `${input} -> ${expected}`);
  }
});

test("sanitize-response: falls back to end_turn for unknown stop_reason", () => {
  const body = sanitizeAnthropicResponse({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: "some_unknown_value",
    usage: {},
  });
  assert.equal(body.stop_reason, "end_turn");
});

test("sanitize-response: preserves valid stop_reason values", () => {
  for (const reason of [
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
  ]) {
    const body = sanitizeAnthropicResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: reason,
      usage: {},
    });
    assert.equal(body.stop_reason, reason);
  }
});

test("sanitize-response: preserves all valid Anthropic response fields", () => {
  const body = sanitizeAnthropicResponse({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    container: { id: "c-1", expires_at: "2026-01-01" },
  });
  assert.equal(body.id, "msg_1");
  assert.equal(body.model, "claude-opus-4-8");
  assert.deepEqual(body.content, [{ type: "text", text: "hi" }]);
  assert.equal(body.stop_sequence, null);
  assert.equal(body.stop_details, null);
  assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 5 });
  assert.deepEqual(body.container, { id: "c-1", expires_at: "2026-01-01" });
});

test("sanitize-response: ensures content is an array", () => {
  const body = sanitizeAnthropicResponse({
    id: "msg_1",
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    usage: {},
  });
  assert.ok(Array.isArray(body.content));
});
