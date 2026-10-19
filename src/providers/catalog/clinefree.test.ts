import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBodyTransforms, type TransformCtx } from "../../formats/pipeline";
import { clinefree } from "./clinefree";
import { WireKind, type Provider } from "../../types";

const provider = {
  id: "clinefree",
  name: "Cline Free",
  catalogId: "clinefree",
  baseUrl: "https://api.cline.bot",
  basePath: "/api/v1",
  endpoints: [WireKind.Chat],
  format: null,
  host: "api.cline.bot",
  tlsVerify: true,
  extraHeaders: {},
  authScheme: "bearer",
  enabled: true,
} as unknown as Provider;

const context: TransformCtx = {
  provider,
  clientFmt: WireKind.Chat,
  providerFmt: WireKind.Chat,
  state: {},
};

test("Cline Free remains chat-native and exposes only the envelope unwrapper", () => {
  const template = clinefree.toTemplate();
  assert.deepEqual(template.defaults.endpoints, [WireKind.Chat]);
  assert.equal(template.defaults.nativeConversion, false);
  const stages = clinefree.responseTransforms(provider);
  assert.deepEqual(
    stages.map((stage) => stage.name),
    ["clinefree:unwrap-response"],
  );
  assert.deepEqual(clinefree.streamTransforms(provider), []);
});

test("buffered Cline envelope unwraps nested data", () => {
  const stages = clinefree.responseTransforms(provider);
  const inner = {
    id: "r",
    choices: [
      {
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
  };
  const body = applyBodyTransforms(
    stages as never,
    { data: inner, success: true },
    context,
  ) as Record<string, unknown>;
  assert.deepEqual(body, inner);
});

function applyRequest(body: Record<string, unknown>): Record<string, unknown> {
  const stages = clinefree.requestTransforms(provider);
  assert.deepEqual(
    stages.map((stage) => stage.name),
    ["clinefree:prompt-cache"],
  );
  return applyBodyTransforms(stages as never, body, context) as Record<
    string,
    unknown
  >;
}

test("Cline Free request adds ephemeral cache_control at top level and latest user message", () => {
  const out = applyRequest({
    model: "m",
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ],
  });
  assert.deepEqual(out.cache_control, { type: "ephemeral" });
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1].cache_control, { type: "ephemeral" });
  assert.equal(messages[0].cache_control, undefined);
  assert.equal(out.prompt_cache_retention, undefined);
  assert.equal(out.prompt_cache_key, undefined);
});

test("Cline Free request preserves client-supplied cache markers", () => {
  const out = applyRequest({
    model: "m",
    cache_control: { type: "ephemeral", ttl: "1h" },
    messages: [
      { role: "user", content: "first" },
      {
        role: "user",
        content: "latest",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ],
  });
  assert.deepEqual(out.cache_control, { type: "ephemeral", ttl: "1h" });
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0].cache_control, undefined);
  assert.deepEqual(messages[1].cache_control, {
    type: "ephemeral",
    ttl: "5m",
  });
});

test("Cline Free request without a user message gets only the top-level marker", () => {
  const out = applyRequest({
    model: "m",
    messages: [{ role: "assistant", content: "hi" }],
  });
  assert.deepEqual(out.cache_control, { type: "ephemeral" });
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0].cache_control, undefined);
});

test("Cline Free request leaves Anthropic-shaped bodies untouched", () => {
  const body = {
    model: "m",
    system: "S",
    messages: [{ role: "user", content: "U" }],
  };
  const out = applyRequest({ ...body });
  assert.equal(out.cache_control, undefined);
  assert.deepEqual(out.messages, body.messages);
});
