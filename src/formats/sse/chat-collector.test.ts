import { test } from "node:test";
import assert from "node:assert/strict";
import { collectChatSse } from "./chat-collector";

function sse(...events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("collects plain text and terminal metadata", () => {
  const response = collectChatSse(
    sse(
      { id: "chat_1", created: 10, model: "m", choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo", reasoning_content: "think" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
    ) + "data: [DONE]\n\n",
  );
  assert.deepEqual(response, {
    id: "chat_1",
    created: 10,
    model: "m",
    object: "chat.completion",
    choices: [{ index: 0, message: { content: "Hello", reasoning_content: "think" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  });
});

test("assembles fragmented tool calls by index", () => {
  const response = collectChatSse(
    sse(
      { id: "tool_1", model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "hello" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "" } }] }, finish_reason: "tool_calls" }] },
    ),
  );
  assert.deepEqual(response.choices, [{
    index: 0,
    message: { tool_calls: [{ index: 0, type: "function", id: "call_1", function: { name: "search", arguments: '{"q":"hello' } }] },
    finish_reason: "tool_calls",
  }]);
});

test("retains usage from the final usage-bearing chunk", () => {
  const response = collectChatSse(
    "// keepalive\n\n" +
      sse(
        { id: "u1", created: 1, model: "m", choices: [{ delta: { content: "ok" } }], usage: { prompt_tokens: 1 } },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
      ),
  );
  assert.deepEqual(response.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
});
