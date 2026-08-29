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
