// Tool rename/un-rename integration tests — verifies that tool names
// renamed on the request side are reversed on the response side via
// the shared ctx.state rename map.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TransformCtx } from "../../pipeline";
import {
  applyBodyTransforms,
  buildTransformPlan,
  type Json,
} from "../../pipeline";
import { collectDefaults } from "../../transforms/defaults";
import { ThinkingConverter } from "../../thinking";
import { subscriptionRequestStack, subscriptionResponseStack } from "./index";

function makeCtx(over: Partial<TransformCtx> = {}): TransformCtx {
  return {
    provider: { id: "p", catalogId: "claude-code" } as never,
    clientFmt: "messages",
    providerFmt: "messages",
    upstreamModel: "claude-sonnet-4-6",
    state: {},
    ...over,
  };
}

test("tool-normalize renames execute_python → ExecutePython and un-rename reverses it", () => {
  const ctx = makeCtx();

  // Simulate request side: tool-normalize renames tools.
  const reqBody: Json = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    tools: [
      {
        name: "execute_python",
        description: "Run Python",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
  applyBodyTransforms(subscriptionRequestStack as never, reqBody, ctx);

  // The rename map should be populated.
  const renameMap = ctx.state!["toolRenameMap"] as Map<string, string>;
  assert.ok(renameMap, "rename map should exist");
  assert.equal(renameMap.get("ExecutePython"), "execute_python");

  // Simulate response side: the upstream returns the PascalCased name.
  const respBody: Json = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text: "Running code:" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "ExecutePython",
        input: { code: "print(1)" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const result = applyBodyTransforms(
    subscriptionResponseStack as never,
    respBody,
    ctx,
  );

  // The tool name should be reversed back to the client's original.
  const toolBlock = (
    result.content as Array<{ type: string; name?: string }>
  ).find((b) => b.type === "tool_use");
  assert.ok(toolBlock, "expected a tool_use block");
  assert.equal(toolBlock!.name, "execute_python");
});

test("un-rename is a no-op when no tools were renamed", () => {
  const ctx = makeCtx();
  // No request-side tool-normalize ran — state has no rename map.

  const respBody: Json = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "SomeTool",
        input: {},
      },
    ],
    stop_reason: "tool_use",
    usage: {},
  };
  const result = applyBodyTransforms(
    subscriptionResponseStack as never,
    respBody,
    ctx,
  );
  const toolBlock = (
    result.content as Array<{ type: string; name?: string }>
  ).find((b) => b.type === "tool_use");
  assert.equal(toolBlock!.name, "SomeTool");
});

test("full pipeline: responses client → messages provider, tool names reversed end-to-end", () => {
  const defaults = collectDefaults({
    thinking: new ThinkingConverter(),
    providerFmt: "messages",
  });
  const plan = buildTransformPlan(
    "responses",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    {
      request: [...defaults.request, ...(subscriptionRequestStack as never[])],
      response: [
        ...defaults.response,
        ...(subscriptionResponseStack as never[]),
      ],
    },
  );

  const ctx = makeCtx({ clientFmt: "responses", providerFmt: "messages" });

  // Request side: tools are renamed by the subscription hooks.
  const reqBody: Json = {
    model: "claude-sonnet-4-6",
    input: "Write some code",
    max_output_tokens: 1024,
    tools: [
      {
        type: "function",
        name: "execute_python",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
  applyBodyTransforms(plan.request, reqBody, ctx);
  assert.ok(
    (ctx.state!["toolRenameMap"] as Map<string, string>)?.size > 0,
    "rename map should be populated after request transforms",
  );

  // Response side: messages-shaped response with PascalCased tool name.
  const respBody: Json = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "text", text: "Running:" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "ExecutePython",
        input: { code: "print(1)" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const result = applyBodyTransforms(plan.response, respBody, ctx);

  // If clientFmt is "responses", the pipeline should have bridged to
  // responses format. Check both the messages-stage un-rename AND the
  // final output format.
  const output = result.output as
    Array<{ type: string; name?: string }> | undefined;
  if (output) {
    // Responses format: function_call items.
    const fc = output.find((o) => o.type === "function_call");
    assert.ok(fc, "expected a function_call output item");
    assert.equal(
      fc!.name,
      "execute_python",
      "function_call name should be un-renamed",
    );
  } else {
    // Still in messages format (no bridge in plan) — check content blocks.
    const blocks = result.content as Array<{ type: string; name?: string }>;
    const tu = blocks.find((b) => b.type === "tool_use");
    assert.ok(tu, "expected a tool_use block");
    assert.equal(
      tu!.name,
      "execute_python",
      "tool_use name should be un-renamed",
    );
  }
});

test("full pipeline: chat client → messages provider, tool names reversed", () => {
  const defaults = collectDefaults({
    thinking: new ThinkingConverter(),
    providerFmt: "messages",
  });
  const plan = buildTransformPlan(
    "chat",
    { forwardPath: "/v1/messages", providerFmt: "messages" },
    {
      request: [...defaults.request, ...(subscriptionRequestStack as never[])],
      response: [
        ...defaults.response,
        ...(subscriptionResponseStack as never[]),
      ],
    },
  );

  const ctx = makeCtx({ clientFmt: "chat", providerFmt: "messages" });

  // Request side.
  const reqBody: Json = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    tools: [
      {
        type: "function",
        function: {
          name: "execute_python",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };
  applyBodyTransforms(plan.request, reqBody, ctx);

  // Response side.
  const respBody: Json = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "ExecutePython",
        input: { code: "print(1)" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const result = applyBodyTransforms(plan.response, respBody, ctx);

  // Chat format: tool_calls array.
  const choices = result.choices as Array<{
    message?: { tool_calls?: Array<{ function?: { name?: string } }> };
  }>;
  if (choices) {
    const tc = choices[0]?.message?.tool_calls?.[0];
    assert.ok(tc, "expected a tool_call");
    assert.equal(tc!.function?.name, "execute_python");
  } else {
    // Still messages shape.
    const blocks = result.content as Array<{ type: string; name?: string }>;
    const tu = blocks.find((b) => b.type === "tool_use");
    assert.equal(tu!.name, "execute_python");
  }
});

test("un-rename works for multiple tool_use blocks", () => {
  const ctx = makeCtx();

  // Request side renames two tools.
  const reqBody: Json = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    tools: [
      { name: "run_code", input_schema: { type: "object", properties: {} } },
      { name: "read_file", input_schema: { type: "object", properties: {} } },
    ],
  };
  applyBodyTransforms(subscriptionRequestStack as never, reqBody, ctx);

  const respBody: Json = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      { type: "tool_use", id: "t1", name: "RunCode", input: {} },
      { type: "tool_use", id: "t2", name: "ReadFile", input: {} },
    ],
    stop_reason: "tool_use",
    usage: {},
  };
  const result = applyBodyTransforms(
    subscriptionResponseStack as never,
    respBody,
    ctx,
  );
  const blocks = (
    result.content as Array<{ type: string; name?: string }>
  ).filter((b) => b.type === "tool_use");
  assert.equal(blocks[0].name, "run_code");
  assert.equal(blocks[1].name, "read_file");
});
