// HyperCharm adapter contract: template defaults (three wire endpoints,
// "both" auth schemes, pinned base URL), OpenAI-native format, and verbatim
// chat forwarding - the engine composes auth headers (Bearer + x-api-key for
// "both", see providers/base/url.ts) upstream of the adapter, so the build
// must forward them untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hypercharm } from "./hypercharm";
import { WireKind } from "../../types";
import type { BuildCtx } from "../base";

const PROVIDER = {
  id: "hypercharm-provider",
  name: "HyperCharm",
  baseUrl: "https://hyper.charm.land",
  basePath: "/v1",
  modelsPath: "/models",
  endpoints: [WireKind.Chat, WireKind.Messages, WireKind.Responses] as WireKind[],
  authScheme: "both" as const,
  format: null,
  host: "hyper.charm.land",
  tlsVerify: true,
  extraHeaders: {},
  proxy: null,
  enabled: true,
  catalogId: "hypercharm",
};

function buildCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  return {
    provider: PROVIDER as never,
    model: "claude-sonnet-4-5",
    body: { model: "claude-sonnet-4-5", stream: false },
    apiKey: "sk-hyper-test",
    keyMetadata: {},
    clientFmt: WireKind.Chat,
    providerFmt: WireKind.Chat,
    endpointKind: WireKind.Chat,
    forwardPath: "/chat/completions",
    baseUrl: PROVIDER.baseUrl,
    basePath: PROVIDER.basePath,
    resolve: ((target?: unknown) =>
      `${PROVIDER.baseUrl}${PROVIDER.basePath}${
        typeof target === "string" ? target : ""
      }`) as never,
    url: `${PROVIDER.baseUrl}${PROVIDER.basePath}/chat/completions`,
    headers: {
      authorization: "Bearer sk-hyper-test",
      "x-api-key": "sk-hyper-test",
      "content-type": "application/json",
      accept: "application/json",
    },
    ...overrides,
  };
}

test("hypercharm template pins the Hyper endpoints with both auth headers", () => {
  const tpl = hypercharm.toTemplate();
  assert.equal(tpl.id, "hypercharm");
  assert.equal(tpl.label, "HyperCharm");
  assert.equal(tpl.brand, "hypercharm");
  assert.equal(tpl.docsUrl, "https://hyper.charm.land/docs/");
  assert.equal(tpl.defaults.baseUrl, "https://hyper.charm.land");
  assert.equal(tpl.defaults.basePath, "/v1");
  assert.equal(tpl.defaults.modelsPath, "/models");
  assert.deepEqual(tpl.defaults.endpoints, [
    WireKind.Chat,
    WireKind.Messages,
    WireKind.Responses,
  ]);
  assert.equal(tpl.defaults.authScheme, "both");
  assert.equal(tpl.defaults.nativeConversion, false);
});

test("hypercharm is OpenAI-native", () => {
  assert.equal(hypercharm.nativeFormat, "openai");
});

test("chat build forwards the composed URL, body, and both auth headers verbatim", () => {
  const ctx = buildCtx();
  const built = hypercharm.chatCompletions(ctx);
  assert.equal(built.url, "https://hyper.charm.land/v1/chat/completions");
  assert.equal(built.body, ctx.body);
  assert.equal(built.headers["authorization"], "Bearer sk-hyper-test");
  assert.equal(built.headers["x-api-key"], "sk-hyper-test");
});
