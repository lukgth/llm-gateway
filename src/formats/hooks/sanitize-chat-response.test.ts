import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeChatResponse } from "./sanitize-chat-response";

test("chat-response: preserves valid finish_reasons", () => {
  for (const fr of ["stop", "length", "tool_calls", "content_filter"]) {
    const body = sanitizeChatResponse({
      id: "c1",
      choices: [
        { index: 0, message: { role: "assistant" }, finish_reason: fr },
      ],
    });
    assert.equal(body.choices![0].finish_reason, fr);
  }
});

test("chat-response: maps Anthropic stop_reasons to Chat finish_reasons", () => {
  const map: Record<string, string> = {
    end_turn: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
    stop_sequence: "stop",
    pause_turn: "stop",
    refusal: "content_filter",
  };
  for (const [input, expected] of Object.entries(map)) {
    const body = sanitizeChatResponse({
      id: "c1",
      choices: [
        { index: 0, message: { role: "assistant" }, finish_reason: input },
      ],
    });
    assert.equal(
      body.choices![0].finish_reason,
      expected,
      `${input} -> ${expected}`,
    );
  }
});

test("chat-response: unknown finish_reason defaults to stop", () => {
  const body = sanitizeChatResponse({
    id: "c1",
    choices: [
      { index: 0, message: { role: "assistant" }, finish_reason: "bizarre" },
    ],
  });
  assert.equal(body.choices![0].finish_reason, "stop");
});

test("chat-response: forces tool_calls when tool_calls array is present", () => {
  const body = sanitizeChatResponse({
    id: "c1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
          ],
        },
        finish_reason: "stop",
      },
    ],
  });
  assert.equal(body.choices![0].finish_reason, "tool_calls");
});

test("chat-response: sets object to chat.completion when missing", () => {
  const body = sanitizeChatResponse({ id: "c1", choices: [] });
  assert.equal(body.object, "chat.completion");
});
