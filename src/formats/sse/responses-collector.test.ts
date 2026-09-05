import { test } from "node:test";
import assert from "node:assert/strict";
import { collectResponsesSse } from "./responses-collector";

function sse(...events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("populated terminal output takes precedence over buffered deltas", () => {
  const terminal = {
    id: "resp_complete",
    object: "response",
    status: "completed",
    model: "upstream",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "authoritative result" }],
      },
    ],
    usage: { input_tokens: 4, output_tokens: 3 },
  };
  const response = collectResponsesSse(sse(
    { type: "response.output_text.delta", delta: "draft" },
    { type: "response.completed", response: terminal },
  ));
  assert.deepEqual(response, terminal);
});

test("compact terminals recover indexed text and retain response metadata", () => {
  const response = collectResponsesSse(sse(
    {
      type: "response.created",
      response: {
        id: "resp_compact",
        object: "response",
        model: "initial-model",
        created_at: 100,
        status: "in_progress",
        metadata: { trace: "kept" },
      },
    },
    {
      type: "response.in_progress",
      response: { model: "updated-model", system_fingerprint: "fp_1" },
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "hello " },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "world" },
    { type: "response.output_text.done", item_id: "msg_1" },
    {
      type: "response.content_part.done",
      item_id: "msg_1",
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_item.done",
      item_id: "msg_1",
      item: { id: "msg_1", type: "message", status: "completed", content: [] },
    },
    {
      type: "response.completed",
      response: { model: "terminal-model", output: [], usage: { output_tokens: 2 } },
    },
  ));
  assert.deepEqual(response, {
    id: "resp_compact",
    object: "response",
    model: "terminal-model",
    created_at: 100,
    status: "completed",
    metadata: { trace: "kept" },
    system_fingerprint: "fp_1",
    usage: { output_tokens: 2 },
    output: [{
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello world", annotations: [] }],
    }],
  });
});

test("done-only tool and reasoning items survive compact Codex terminals in output order", () => {
  const tool = {
    id: "tool_1",
    type: "function_call",
    call_id: "call_1",
    name: "lookup",
    arguments: '{"q":"hello"}',
    status: "completed",
  };
  const reasoning = {
    id: "reasoning_1",
    type: "reasoning",
    encrypted_content: "encrypted",
    summary: [{ type: "summary_text", text: "checking" }],
  };
  const response = collectResponsesSse(sse(
    { type: "response.output_item.done", output_index: 1, item: tool },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ));
  assert.deepEqual(response.output, [reasoning, tool]);
});

test("function argument deltas are retained when done events contain empty arguments", () => {
  const response = collectResponsesSse(sse(
    {
      type: "response.output_item.added",
      output_index: 3,
      item: {
        id: "tool_1",
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", item_id: "tool_1", delta: '{"q":' },
    { type: "response.function_call_arguments.delta", item_id: "tool_1", delta: '"hello"}' },
    { type: "response.function_call_arguments.done", item_id: "tool_1", arguments: "" },
    {
      type: "response.output_item.done",
      item_id: "tool_1",
      item: { id: "tool_1", type: "function_call", arguments: "" },
    },
    { type: "response.completed", response: { output: [] } },
  ));
  assert.deepEqual(response.output, [{
    id: "tool_1",
    type: "function_call",
    call_id: "call_1",
    name: "lookup",
    arguments: '{"q":"hello"}',
  }]);
});

test("text and function done events replace deltas instead of duplicating them", () => {
  const response = collectResponsesSse(sse(
    { type: "response.output_text.delta", output_index: 0, delta: "draft" },
    { type: "response.output_text.done", output_index: 0, text: "final" },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "{" },
    { type: "response.function_call_arguments.done", output_index: 1, arguments: "{}" },
    { type: "response.completed", response: {} },
  ));
  assert.deepEqual(response.output, [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "final" }] },
    { type: "function_call", arguments: "{}" },
  ]);
});

test("incomplete terminals preserve partial output, status, details and usage", () => {
  const terminal = {
    id: "resp_partial",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "partial result" }],
    }],
    usage: { input_tokens: 9, output_tokens: 5 },
  };
  const response = collectResponsesSse(sse({ type: "response.incomplete", response: terminal }));
  assert.deepEqual(response, terminal);
});

test("compact incomplete terminals recover content and infer their terminal status", () => {
  const response = collectResponsesSse(sse(
    { type: "response.created", response: { id: "resp_partial", status: "in_progress" } },
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.incomplete", response: { output: [], usage: { output_tokens: 1 } } },
  ));
  assert.equal(response.status, "incomplete");
  assert.equal(response.id, "resp_partial");
  assert.deepEqual(response.output, [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "partial" }],
  }]);
  assert.deepEqual(response.usage, { output_tokens: 1 });
});

test("named terminal events accept bare response bodies and unterminated final frames", () => {
  const terminal = {
    id: "resp_named",
    status: "completed",
    output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }],
  };
  const response = collectResponsesSse(
    `: keepalive\n\nevent: response.completed\ndata: ${JSON.stringify(terminal)}`,
  );
  assert.deepEqual(response, terminal);
});

test("failed events reject buffered partial output rather than report a missing terminal", () => {
  assert.throws(() => collectResponsesSse(sse(
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.failed", response: { status: "failed", error: { message: "upstream failed" } } },
  )), /failed/);
});

test("error events cannot be masked by an earlier successful terminal", () => {
  assert.throws(() => collectResponsesSse(sse(
    { type: "response.completed", response: { status: "completed", output: [] } },
    { type: "error", message: "upstream failed" },
  )), /failed/);
});

test("failed status cannot masquerade as a completed response", () => {
  assert.throws(() => collectResponsesSse(sse(
    { type: "response.completed", response: { status: "failed", output: [] } },
  )), /failed/);
});

test("EOF and DONE without a terminal response reject buffered partial output", () => {
  assert.throws(() => collectResponsesSse(
    sse({ type: "response.output_text.delta", delta: "partial" }) + "data: [DONE]\n\n",
  ), /terminal/);
});

test("malformed event data is rejected even before a valid terminal", () => {
  assert.throws(() => collectResponsesSse(
    "data: {not-json}\n\n" + sse({ type: "response.completed", response: {} }),
  ), /malformed/);
});

test("terminal events without a response body cannot complete a buffered response", () => {
  assert.throws(() => collectResponsesSse(sse({ type: "response.incomplete" })), Error);
});
