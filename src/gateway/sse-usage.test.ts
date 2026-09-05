// SseUsageObserver tests. Per the format-route completeness audit, this had
// NO dedicated test before this - only indirectly touched by an engine-level
// streaming test that asserts on an error event, never on usage. Covers all
// three usage-nesting shapes it reads (top-level, .message.usage,
// .response.usage), the chars/4 fallback estimate, cached-token extraction,
// pass-through-verbatim behavior, and the optional debug capture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SseUsageObserver } from "./sse-usage";
import { readResponseUsage } from "../formats/tokens";

// Feed a Transform a sequence of raw SSE text chunks and collect everything
// written back out, concatenated - used to assert pass-through-verbatim.
function feed(observer: SseUsageObserver, chunks: string[]): string {
  const out: Buffer[] = [];
  observer.on("data", (c: Buffer) => out.push(c));
  for (const c of chunks) observer.write(Buffer.from(c, "utf8"));
  return Buffer.concat(out).toString("utf8");
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// --- pass-through -------------------------------------------------------------

test("forwards every byte unchanged (pure observer, no rewriting)", () => {
  const o = new SseUsageObserver();
  const chunks = [
    sseLine({ choices: [{ delta: { content: "hi" } }] }),
    "data: [DONE]\n\n",
  ];
  const forwarded = feed(o, chunks);
  assert.equal(forwarded, chunks.join(""));
});

test("a malformed/non-JSON data line never throws or breaks the stream", () => {
  const o = new SseUsageObserver();
  assert.doesNotThrow(() => {
    feed(o, [
      "data: {not valid json\n\n",
      sseLine({ usage: { input_tokens: 1 } }),
    ]);
  });
  assert.equal(o.usage(0).input, 1);
});

test("a chunk split mid-line is buffered correctly across _transform calls", () => {
  const o = new SseUsageObserver();
  const full = sseLine({ usage: { input_tokens: 7, output_tokens: 3 } });
  const mid = Math.floor(full.length / 2);
  feed(o, [full.slice(0, mid), full.slice(mid)]);
  const usage = o.usage(0);
  assert.equal(usage.input, 7);
  assert.equal(usage.output, 3);
});

// --- usage: three nesting shapes ----------------------------------------------

test("reads top-level .usage (OpenAI Chat final chunk)", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ usage: { prompt_tokens: 10, completion_tokens: 5 } })]);
  const usage = o.usage(0);
  assert.equal(usage.input, 10);
  assert.equal(usage.output, 5);
});

test("reads .message.usage (Anthropic message_start/message_delta)", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      type: "message_start",
      message: { usage: { input_tokens: 20, output_tokens: 0 } },
    }),
    sseLine({
      type: "message_delta",
      message: { usage: { output_tokens: 8 } },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.input, 20);
  assert.equal(usage.output, 8);
});

test("reads .response.usage (OpenAI Responses response.completed)", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      type: "response.completed",
      response: { usage: { input_tokens: 15, output_tokens: 6 } },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.input, 15);
  assert.equal(usage.output, 6);
});

test("output is cumulative/one-shot: the MAX seen across multiple usage events wins", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ usage: { output_tokens: 3 } }),
    sseLine({ usage: { output_tokens: 9 } }),
    sseLine({ usage: { output_tokens: 5 } }), // lower than the max seen so far
  ]);
  assert.equal(o.usage(0).output, 9);
});

test("prefers input_tokens/output_tokens over prompt_tokens/completion_tokens when both appear on the same event", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        input_tokens: 99,
        output_tokens: 99,
      },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.input, 99);
  assert.equal(usage.output, 99);
});

test("streaming and buffered usage normalize provider fields identically", () => {
  const cases = [
    {
      usage: {
        input_tokens: 100,
        output_tokens: 8,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 200,
      },
      expected: { input: 900, output: 8, cached: 600, cacheWrite: 200 },
    },
    {
      usage: {
        prompt_tokens: 900,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
      },
      expected: { input: 900, output: 8, cached: 600, cacheWrite: 200 },
    },
    {
      usage: {
        input_tokens: 900,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 600, cache_creation_tokens: 200 },
      },
      expected: { input: 900, output: 8, cached: 600, cacheWrite: 200 },
    },
    {
      usage: {
        promptTokenCount: 900,
        candidatesTokenCount: 8,
        cachedContentTokenCount: 600,
      },
      expected: { input: 900, output: 8, cached: 600 },
    },
    {
      usage: { totalTokenCount: 908, candidatesTokenCount: 8 },
      expected: { input: 900, output: 8 },
    },
    {
      usage: {
        input_tokens: -1,
        output_tokens: "invalid",
        prompt_tokens: 900,
        completion_tokens: 8,
        cache_read_input_tokens: -1,
        cache_creation_input_tokens: -1,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
      },
      expected: { input: 900, output: 8, cached: 600, cacheWrite: 200 },
    },
  ];
  for (const { usage, expected } of cases) {
    const o = new SseUsageObserver();
    feed(o, [sseLine({ response: { usage } })]);
    assert.deepEqual(readResponseUsage({ usage }), expected);
    assert.deepEqual(o.usage(0), expected);
  }
});

test("partial and decreasing usage events preserve cumulative normalized totals", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      },
    }),
    sseLine({ type: "message_delta", usage: { output_tokens: 8 } }),
    sseLine({ usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1 } }),
  ]);
  assert.deepEqual(o.usage(0), { input: 35, output: 8, cached: 20, cacheWrite: 5 });
});

// --- cached tokens -------------------------------------------------------------

test("reads cached tokens via readCachedTokens (Anthropic + OpenAI shapes)", () => {
  const anthropic = new SseUsageObserver();
  feed(anthropic, [
    sseLine({
      usage: { input_tokens: 10, cache_read_input_tokens: 4 },
    }),
  ]);
  assert.equal(anthropic.usage(0).cached, 4);
  // Anthropic's input_tokens excludes cached; normalised to total = 10 + 4.
  assert.equal(anthropic.usage(0).input, 14);

  const openai = new SseUsageObserver();
  feed(openai, [
    sseLine({
      usage: {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 6 },
      },
    }),
  ]);
  assert.equal(openai.usage(0).cached, 6);
  // OpenAI's prompt_tokens already includes cached - no addition.
  assert.equal(openai.usage(0).input, 10);
});

test("cached is omitted from usage() when never reported", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ usage: { input_tokens: 10, output_tokens: 5 } })]);
  assert.equal(o.usage(0).cached, undefined);
  assert.equal(o.usage(0).cacheWrite, undefined);
});

test("tracks cache writes for Anthropic message_start usage", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 200,
      },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.cached, 600);
  assert.equal(usage.cacheWrite, 200);
  assert.equal(usage.input, 900);
});

test("tracks OpenAI/Cline nested write metadata without double-addition", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      usage: {
        prompt_tokens: 900,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
      },
    }),
  ]);
  const usage = o.usage(0);
  assert.equal(usage.cached, 600);
  assert.equal(usage.cacheWrite, 200);
  assert.equal(usage.input, 900);
});

test("cache buckets keep the max across usage events", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    }),
    sseLine({
      usage: {
        input_tokens: 50,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 200,
      },
    }),
  ]);
  assert.equal(o.usage(0).cached, 600);
  assert.equal(o.usage(0).cacheWrite, 200);
});

// --- fallback estimate (no usage reported at all) -----------------------------

test("falls back to a chars/4 estimate of streamed text when no usage is ever reported", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ choices: [{ delta: { content: "12345678" } }] }), // 8 chars
    sseLine({ choices: [{ delta: { content: "1234" } }] }), // 4 chars
  ]);
  // 12 chars total -> ceil(12/4) = 3
  assert.equal(o.usage(0).output, 3);
});

test("upstream-reported output always wins over the fallback estimate", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ choices: [{ delta: { content: "a".repeat(400) } }] }), // would estimate to 100
    sseLine({ usage: { output_tokens: 5 } }),
  ]);
  assert.equal(o.usage(0).output, 5);
});

test("input falls back to the caller's pre-request estimate when nothing was reported", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ choices: [{ delta: { content: "hi" } }] })]);
  assert.equal(o.usage(42).input, 42);
});

test("fallback accumulates Responses-format string deltas too", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ type: "response.output_text.delta", delta: "12345678" }), // 8 chars
  ]);
  assert.equal(o.usage(0).output, 2); // ceil(8/4)
});

test("fallback accumulates Anthropic text/thinking deltas via the generic .delta object shape", () => {
  const o = new SseUsageObserver();
  feed(o, [
    sseLine({ type: "content_block_delta", delta: { text: "12345678" } }), // 8 chars
    sseLine({ type: "content_block_delta", delta: { thinking: "1234" } }), // 4 chars
  ]);
  assert.equal(o.usage(0).output, 3); // ceil(12/4)
});

// --- [DONE] / empty lines ------------------------------------------------------

test("[DONE] and blank data lines are skipped without error", () => {
  const o = new SseUsageObserver();
  assert.doesNotThrow(() => {
    feed(o, ["data: [DONE]\n\n", "data:\n\n", "data: \n\n"]);
  });
  assert.deepEqual(o.usage(0), { input: undefined, output: undefined });
});

// --- debug capture (off by default) --------------------------------------------

test("responseSummary() is null when capture is off (the default)", () => {
  const o = new SseUsageObserver();
  feed(o, [sseLine({ choices: [{ delta: { content: "hi" } }] })]);
  assert.equal(o.responseSummary(), null);
});

test("responseSummary() captures text, tool calls, and stop reason when capture:true", () => {
  const o = new SseUsageObserver({ capture: true });
  feed(o, [
    sseLine({
      choices: [
        {
          delta: {
            content: "hi",
            tool_calls: [
              { index: 0, function: { name: "search", arguments: '{"q":' } },
            ],
          },
        },
      ],
    }),
    sseLine({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
  ]);
  const summary = o.responseSummary();
  assert.ok(summary);
  assert.equal(summary!.text, "hi");
  assert.equal(summary!.toolCalls?.[0].name, "search");
  assert.equal(summary!.toolCalls?.[0].arguments, '{"q":"x"}');
  assert.equal(summary!.stopReason, "tool_calls");
});

test("responseSummary() captures Anthropic tool_use + thinking text via content_block events", () => {
  const o = new SseUsageObserver({ capture: true });
  feed(o, [
    sseLine({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "search" },
    }),
    sseLine({
      type: "content_block_delta",
      index: 0,
      delta: { partial_json: '{"q":"x"}' },
    }),
    sseLine({
      type: "content_block_delta",
      delta: { thinking: "let me think" },
    }),
    sseLine({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
  ]);
  const summary = o.responseSummary();
  assert.ok(summary);
  assert.equal(summary!.text, "let me think");
  assert.equal(summary!.toolCalls?.[0].name, "search");
  assert.equal(summary!.toolCalls?.[0].arguments, '{"q":"x"}');
  assert.equal(summary!.stopReason, "tool_use");
});

test("Responses added/delta/done/completed captures one call without repeated arguments", () => {
  const o = new SseUsageObserver({ capture: true });
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: "{}" };
  feed(o, [
    sseLine({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }),
    sseLine({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: "{" }),
    sseLine({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: "}" }),
    sseLine({ type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: "{}" }),
    sseLine({ type: "response.output_item.done", output_index: 0, item }),
    sseLine({ type: "response.completed", response: { status: "completed", output: [item] } }),
  ]);
  assert.deepEqual(o.responseSummary(), {
    toolCalls: [{ name: "search", arguments: "{}" }],
    stopReason: "tool_calls",
  });
});

test("Responses completed output positions include reasoning and messages before tools", () => {
  const o = new SseUsageObserver({ capture: true });
  const first = { type: "function_call", name: "first", arguments: "{}" };
  const second = { type: "function_call", name: "second", arguments: '{"x":1}' };
  feed(o, [
    sseLine({ type: "response.output_item.added", output_index: 1, item: first }),
    sseLine({ type: "response.output_item.added", output_index: 3, item: second }),
    sseLine({ type: "response.function_call_arguments.delta", output_index: 1, delta: first.arguments }),
    sseLine({ type: "response.function_call_arguments.delta", output_index: 3, delta: second.arguments }),
    sseLine({ type: "response.output_item.done", output_index: 1, item: first }),
    sseLine({ type: "response.output_item.done", output_index: 3, item: second }),
    sseLine({
      type: "response.completed",
      response: { output: [{ type: "reasoning" }, first, { type: "message" }, second] },
    }),
  ]);
  assert.deepEqual(o.responseSummary()?.toolCalls, [
    { name: "first", arguments: "{}" },
    { name: "second", arguments: '{"x":1}' },
  ]);
});

test("Responses stable identities correlate indexless deltas and compact completed output", () => {
  const o = new SseUsageObserver({ capture: true });
  const first = { type: "function_call", id: "fc_1", call_id: "call_1", name: "first", arguments: "{}" };
  const second = { type: "function_call", id: "fc_2", call_id: "call_2", name: "second", arguments: '{"x":1}' };
  feed(o, [
    sseLine({ type: "response.output_item.added", output_index: 1, item: first }),
    sseLine({ type: "response.output_item.added", output_index: 2, item: second }),
    sseLine({ type: "response.function_call_arguments.delta", item_id: first.id, delta: first.arguments }),
    sseLine({ type: "response.function_call_arguments.done", call_id: second.call_id, arguments: second.arguments }),
    sseLine({ type: "response.output_item.done", item: first }),
    sseLine({ type: "response.output_item.done", item: second }),
    sseLine({ type: "response.completed", response: { output: [second, first] } }),
  ]);
  assert.deepEqual(o.responseSummary()?.toolCalls, [
    { name: "first", arguments: "{}" },
    { name: "second", arguments: '{"x":1}' },
  ]);
});

test("Responses done-only snapshots retain arguments without added or delta events", () => {
  const o = new SseUsageObserver({ capture: true });
  const first = { type: "function_call", call_id: "call_1", name: "first", arguments: "{}" };
  const second = { type: "function_call", call_id: "call_2", name: "second", arguments: '{"x":1}' };
  feed(o, [
    sseLine({ type: "response.output_item.done", item: first }),
    sseLine({ type: "response.completed", response: { output: [{ type: "reasoning" }, first, second] } }),
  ]);
  assert.deepEqual(o.responseSummary(), {
    toolCalls: [
      { name: "first", arguments: "{}" },
      { name: "second", arguments: '{"x":1}' },
    ],
    stopReason: "tool_calls",
  });
});

test("Responses capture caps oversized deltas and does not append terminal snapshots", () => {
  const o = new SseUsageObserver({ capture: true });
  const prefix = "a".repeat(3_999);
  feed(o, [
    sseLine({ type: "response.output_text.delta", delta: "x".repeat(4_100) }),
    sseLine({ type: "response.function_call_arguments.delta", output_index: 0, delta: prefix }),
    sseLine({ type: "response.function_call_arguments.delta", output_index: 0, delta: "bcdef" }),
    sseLine({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", name: "large", arguments: prefix + "bcdef" },
    }),
  ]);
  assert.deepEqual(o.responseSummary(), {
    text: "x".repeat(4_000),
    toolCalls: [{ name: "large", arguments: prefix + "b" }],
  });
});
