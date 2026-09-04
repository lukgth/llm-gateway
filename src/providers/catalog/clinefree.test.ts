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

function invoke(): string {
  return '<|DSML|invoke name="mcp__ao_mcp_search_works"><|DSML|parameter name="rating" string="false">["Mature"]<|DSML|/parameter><|DSML|/invoke>';
}

test("Cline Free remains chat-native and exposes compatibility stages", () => {
  const template = clinefree.toTemplate();
  assert.deepEqual(template.defaults.endpoints, [WireKind.Chat]);
  assert.equal(template.defaults.nativeConversion, false);
  const stages = clinefree.responseTransforms(provider);
  assert.deepEqual(stages.map((stage) => stage.name), [
    "clinefree:unwrap-response",
    "clinefree:dsml-tool-calls",
  ]);
  assert.equal(stages[1].label, "Temporary Cline DSML compatibility workaround");
});

test("buffered Cline envelope unwraps and heals DSML tool calls", () => {
  const stages = clinefree.responseTransforms(provider);
  const body = applyBodyTransforms(
    stages as never,
    {
      data: {
        id: "r",
        choices: [
          {
            message: { role: "assistant", content: `before ${invoke()} after` },
            finish_reason: "stop",
          },
        ],
      },
      success: true,
    },
    context,
  ) as Record<string, unknown>;
  const choice = (body.choices as Array<Record<string, unknown>>)[0];
  const message = choice.message as Record<string, unknown>;
  const call = (message.tool_calls as Array<Record<string, unknown>>)[0];
  assert.equal(message.content, "before  after");
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal((call.function as Record<string, unknown>).name, "mcp__ao_mcp_search_works");
  assert.deepEqual(JSON.parse((call.function as Record<string, unknown>).arguments as string), { rating: ["Mature"] });
});

test("buffered healing repairs degenerate native arguments without duplicating call", () => {
  const stages = clinefree.responseTransforms(provider);
  const body = applyBodyTransforms(
    stages as never,
    {
      choices: [{
        message: {
          role: "assistant",
          content: invoke(),
          tool_calls: [{ id: "native", type: "function", function: { name: "mcp__ao_mcp_search_works", arguments: "{}" } }],
        },
      }],
    },
    context,
  ) as Record<string, unknown>;
  const message = (body.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
  assert.equal((message.tool_calls as unknown[]).length, 1);
  assert.notEqual(((message.tool_calls as Array<Record<string, unknown>>)[0].function as Record<string, unknown>).arguments, "{}");
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
