// DashScope Coding Plan sends the Claude Code user-agent on EVERY outbound
// request - including the model-list GET and the connectivity probe.
//
// Why this is an adapter override and not just quirks.requiredHeaders:
// requiredHeaders is applied by applyTemplateDefaults at provider-CREATE time,
// so it only reaches requests whose stored row happened to be written with it.
// A row created before this provider existed, or one whose extraHeaders an
// operator edited or cleared in the UI, would silently fall back to sending no
// UA at all (nothing else in the probe path sets one). These tests therefore
// drive the adapter with an EMPTY header set - the state that used to fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdapter, getProviderTemplate } from "./index";
import { CC_VERSION } from "../formats/anthropic/subscription/billing";
import { WireKind } from "../types";

const EXPECTED_UA = `claude-cli/${CC_VERSION} (external, cli)`;
const adapter = () => getAdapter("dashscope-coding")!;

// A ModelsCtx whose transport records the headers it is handed.
function modelsCtx(headers: Record<string, string>) {
  const seen: Array<Record<string, string>> = [];
  return {
    seen,
    ctx: {
      baseUrl: "https://coding.dashscope.aliyuncs.com",
      basePath: "/v1",
      modelsPath: "/models",
      url: "https://coding.dashscope.aliyuncs.com/v1/models",
      resolve: () => "https://coding.dashscope.aliyuncs.com/v1/models",
      headers,
      apiKey: "sk-sp-x",
      format: "openai" as const,
      transport: async (
        _url: string,
        init: { headers: Record<string, string> },
      ) => {
        seen.push(init.headers);
        return {
          ok: true,
          status: 200,
          statusText: "",
          json: async () => ({
            object: "list",
            data: [{ id: "qwen3-coder-plus" }],
          }),
        };
      },
    },
  };
}

test("fetchModels sends the Claude Code UA when the row carries no extraHeaders", async () => {
  const { seen, ctx } = modelsCtx({});
  await adapter().fetchModels(ctx as never);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]["user-agent"], EXPECTED_UA);
});

test("testProvider (connectivity probe) also sends the UA", async () => {
  const seen: Array<Record<string, string>> = [];
  await adapter().testProvider({
    baseUrl: "https://coding.dashscope.aliyuncs.com",
    basePath: "/v1",
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    resolve: () => "https://coding.dashscope.aliyuncs.com/v1/models",
    headers: {},
    apiKey: "sk-sp-x",
    request: async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return { status: 200, ok: true, ms: 1, text: "{}", json: () => ({}) };
    },
  } as never);
  assert.equal(seen[0]["user-agent"], EXPECTED_UA);
});

test("an operator's explicit user-agent is not overwritten", async () => {
  const { seen, ctx } = modelsCtx({ "user-agent": "my-custom/9.9" });
  await adapter().fetchModels(ctx as never);
  assert.equal(seen[0]["user-agent"], "my-custom/9.9");
});

test("a differently-cased caller UA is respected, not duplicated", async () => {
  // node emits every distinct key, so "User-Agent" + "user-agent" would put TWO
  // User-Agent headers on the wire.
  const { seen, ctx } = modelsCtx({ "User-Agent": "cline/3.0" });
  await adapter().fetchModels(ctx as never);
  const uaKeys = Object.keys(seen[0]).filter(
    (k) => k.toLowerCase() === "user-agent",
  );
  assert.equal(uaKeys.length, 1, `expected one UA key, got ${uaKeys}`);
  assert.equal(seen[0]["User-Agent"], "cline/3.0");
});

test("both wire kinds carry the UA, and route to the verified paths", () => {
  const mk = (kind: WireKind) => ({
    baseUrl: "https://coding.dashscope.aliyuncs.com",
    basePath: "/v1",
    headers: {},
    body: {},
    apiKey: "sk-sp-x",
    url: "https://coding.dashscope.aliyuncs.com/v1/chat/completions",
    resolve: () => "https://coding.dashscope.aliyuncs.com/v1",
    kind,
  });
  const chat = adapter().chatCompletions(mk(WireKind.Chat) as never);
  const msg = adapter().messages(mk(WireKind.Messages) as never);
  assert.equal(chat.headers["user-agent"], EXPECTED_UA);
  assert.equal(msg.headers["user-agent"], EXPECTED_UA);
  // /apps/anthropic is a BASE, not an endpoint: the bare path 404s live, the
  // /v1/messages suffix is what reaches auth.
  assert.equal(
    msg.url,
    "https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages",
  );
});

test("the template does not advertise /v1/responses (it 404s upstream)", () => {
  const endpoints = getProviderTemplate("dashscope-coding")!.defaults.endpoints;
  assert.ok(endpoints);
  assert.ok(!endpoints.includes(WireKind.Responses));
  assert.ok(endpoints.includes(WireKind.Chat));
  assert.ok(endpoints.includes(WireKind.Messages));
});
