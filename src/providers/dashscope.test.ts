import { test } from "node:test";
import assert from "node:assert/strict";
import { composeUrl, endpointPathFor } from "./base";
import { getAdapter, getProviderTemplate } from "./index";
import { WireKind, type Provider } from "../types";

const template = () => getProviderTemplate("dashscope")!;
const adapter = () => getAdapter("dashscope")!;

function provider(baseUrl: string): Provider {
  const defaults = template().defaults;
  return {
    id: "dashscope-test",
    name: "dashscope-test",
    catalogId: "dashscope",
    baseUrl,
    basePath: defaults.basePath!,
    modelsPath: defaults.modelsPath!,
    format: "openai",
    endpoints: [...defaults.endpoints!],
    authScheme: "bearer",
    nativeConversion: false,
    apiKeys: ["sk-ws-test"],
  } as unknown as Provider;
}

function build(baseUrl: string, kind: WireKind) {
  const p = provider(baseUrl);
  const url = composeUrl(p.baseUrl, p.basePath, endpointPathFor(p, kind));
  const ctx = {
    provider: p,
    baseUrl: p.baseUrl,
    basePath: p.basePath,
    url,
    resolve: (target: WireKind) =>
      composeUrl(p.baseUrl, p.basePath, endpointPathFor(p, target)),
    headers: { authorization: "Bearer sk-ws-test" },
    body: { model: "qwen3-coder-plus" },
    apiKey: "sk-ws-test",
    kind,
  };
  return adapter().buildFor(kind, ctx as never);
}

test("catalog exposes the normal DashScope pay-as-you-go API", () => {
  const t = template();
  assert.equal(t.brand, "qwen");
  assert.equal(t.defaults.baseUrl, "https://dashscope.aliyuncs.com");
  assert.equal(t.defaults.basePath, "/compatible-mode/v1");
  assert.equal(t.defaults.modelsPath, "/models");
  assert.equal(t.defaults.authScheme, "bearer");
  assert.equal(t.defaults.nativeConversion, false);
  assert.deepEqual(t.defaults.endpoints, [WireKind.Chat, WireKind.Responses]);

  const baseUrl = t.fields.find((field) => field.key === "baseUrl");
  const apiKeys = t.fields.find((field) => field.key === "apiKeys");
  assert.equal(baseUrl?.editable, true);
  assert.match(apiKeys?.hint ?? "", /pay-as-you-go/i);
  assert.match(apiKeys?.hint ?? "", /not a Coding Plan key/i);
});

test("standard Chat and Responses paths work on shared and workspace origins", () => {
  for (const origin of [
    "https://dashscope.aliyuncs.com",
    "https://workspace-id.ap-southeast-1.maas.aliyuncs.com",
    "https://workspace-id.cn-beijing.maas.aliyuncs.com",
  ]) {
    assert.equal(
      build(origin, WireKind.Chat).url,
      `${origin}/compatible-mode/v1/chat/completions`,
    );
    assert.equal(
      build(origin, WireKind.Responses).url,
      `${origin}/compatible-mode/v1/responses`,
    );
  }
});

test("PAYG requests do not inherit Coding Plan traits", () => {
  assert.ok(!template().defaults.endpoints?.includes(WireKind.Messages));
  const chat = build("https://dashscope.aliyuncs.com", WireKind.Chat);
  assert.equal(chat.headers["user-agent"], undefined);
  assert.ok(!chat.url.includes("/apps/anthropic/"));
});

test("model probes use the documented Responses endpoint", async () => {
  const p = provider("https://workspace-id.ap-southeast-1.maas.aliyuncs.com");
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const result = await adapter().testModel({
    provider: p,
    model: "qwen3-coder-plus",
    baseUrl: p.baseUrl,
    basePath: p.basePath,
    url: p.baseUrl,
    headers: { authorization: "Bearer sk-ws-test" },
    apiKey: "sk-ws-test",
    resolve: (target: WireKind) =>
      composeUrl(p.baseUrl, p.basePath, endpointPathFor(p, target)),
    request: async (url: string, init: { body: Record<string, unknown> }) => {
      calls.push({ url, body: init.body });
      return {
        status: 200,
        ok: true,
        ms: 1,
        text: "",
        json: () => ({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "hi" }],
            },
          ],
        }),
      };
    },
  } as never);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { reply: "hi" });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://workspace-id.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses",
  );
  assert.equal(calls[0].body.model, "qwen3-coder-plus");
  assert.equal(typeof calls[0].body.input, "string");
});

test("model discovery uses the OpenAI-compatible conventional path", () => {
  const p = provider("https://dashscope.aliyuncs.com");
  assert.equal(
    composeUrl(p.baseUrl, p.basePath, p.modelsPath),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
  );
});
