// Anthropic request field sanitization tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAnthropicRequest } from "./sanitize-request";

const OLD_MODEL = "claude-opus-4-5";
const NEW_MODEL = "claude-opus-4-8";

test("sanitize: strips Chat-only fields", () => {
  const body = sanitizeAnthropicRequest(
    {
      model: NEW_MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
      logprobs: true,
      top_logprobs: 5,
      seed: 42,
      parallel_tool_calls: true,
      response_format: { type: "json_object" },
      max_completion_tokens: 2048,
      user: "u-1",
    },
    NEW_MODEL,
  );
  assert.equal(body.model, NEW_MODEL);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.presence_penalty, undefined);
  assert.equal(body.frequency_penalty, undefined);
  assert.equal(body.logprobs, undefined);
  assert.equal(body.top_logprobs, undefined);
  assert.equal(body.seed, undefined);
  assert.equal(body.parallel_tool_calls, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.user, undefined);
});

test("sanitize: strips gateway intermediate fields and rescues effort into output_config", () => {
  const body = sanitizeAnthropicRequest(
    {
      model: NEW_MODEL,
      messages: [],
      max_tokens: 100,
      reasoning: { effort: "high" },
      reasoning_effort: "high",
    },
    NEW_MODEL,
  );
  assert.equal(body.reasoning, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.output_config, { effort: "high" });
});

test("sanitize: rescues reasoning_effort into output_config.effort when output_config is absent", () => {
  const body = sanitizeAnthropicRequest(
    { model: "m", messages: [], max_tokens: 100, reasoning_effort: "medium" },
    "m",
  );
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.equal(body.reasoning_effort, undefined);
});

test("sanitize: rescues reasoning.effort into output_config.effort when output_config is absent", () => {
  const body = sanitizeAnthropicRequest(
    { model: "m", messages: [], max_tokens: 100, reasoning: { effort: "low" } },
    "m",
  );
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.reasoning, undefined);
});

test("sanitize: does NOT overwrite existing output_config.effort with rescued value", () => {
  const body = sanitizeAnthropicRequest(
    {
      model: "m",
      messages: [],
      max_tokens: 100,
      output_config: { effort: "xhigh" },
      reasoning_effort: "low",
      reasoning: { effort: "low" },
    },
    "m",
  );
  assert.deepEqual(body.output_config, { effort: "xhigh" });
});

test("sanitize: rescues into existing output_config that has no effort", () => {
  const body = sanitizeAnthropicRequest(
    {
      model: "m",
      messages: [],
      max_tokens: 100,
      output_config: { format: { type: "json_schema" } },
      reasoning_effort: "max",
    },
    "m",
  );
  const oc = body.output_config as Record<string, unknown>;
  assert.equal(oc.effort, "max");
  assert.deepEqual(oc.format, { type: "json_schema" });
});

test("sanitize: preserves all allowed Anthropic fields on pre-4.5 model", () => {
  const body = sanitizeAnthropicRequest(
    {
      model: OLD_MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      system: "you are helpful",
      metadata: { user_id: "u-1" },
      stop_sequences: ["END"],
      stream: false,
      temperature: 0.7,
      top_k: 40,
      top_p: 0.9,
      thinking: { type: "adaptive" },
      tool_choice: { type: "auto" },
      tools: [{ name: "f", input_schema: {} }],
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      context_management: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      },
      container: "c-1",
      inference_geo: "us",
      service_tier: "auto",
    },
    OLD_MODEL,
  );
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_k, 40);
  assert.equal(body.top_p, 0.9);
  assert.deepEqual(body.system, [{ type: "text", text: "you are helpful" }]);
  assert.deepEqual(body.metadata, { user_id: "u-1" });
  assert.deepEqual(body.context_management, {
    edits: [{ type: "clear_thinking_20251015", keep: "all" }],
  });
  assert.equal(body.container, "c-1");
  assert.equal(body.inference_geo, "us");
  assert.equal(body.service_tier, "auto");
});

test("sanitize: strips temperature, top_p, top_k on post-4.5 models", () => {
  const body = sanitizeAnthropicRequest(
    {
      model: NEW_MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
    },
    NEW_MODEL,
  );
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.equal(body.top_k, undefined);
  assert.equal(body.max_tokens, 4096);
});

test("sanitize: preserves temperature on pre-4.5 models", () => {
  const body = sanitizeAnthropicRequest(
    {
      model: OLD_MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      temperature: 0.5,
      top_p: 0.8,
      top_k: 50,
    },
    OLD_MODEL,
  );
  assert.equal(body.temperature, 0.5);
  assert.equal(body.top_p, 0.8);
  assert.equal(body.top_k, 50);
});

test("sanitize: strips sampling on fable/mythos models", () => {
  for (const model of ["claude-fable-5", "claude-mythos-5"]) {
    const body = sanitizeAnthropicRequest(
      {
        model,
        messages: [],
        max_tokens: 100,
        temperature: 1.0,
        top_p: 0.9,
      },
      model,
    );
    assert.equal(body.temperature, undefined, `${model}: temperature`);
    assert.equal(body.top_p, undefined, `${model}: top_p`);
  }
});

test("sanitize: no-op on a clean body (no extra keys)", () => {
  const original = {
    model: OLD_MODEL,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
  };
  const result = sanitizeAnthropicRequest({ ...original }, OLD_MODEL);
  assert.deepEqual(result, original);
});
