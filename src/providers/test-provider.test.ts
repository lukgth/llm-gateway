// testProvider() seam tests - the PROVIDER-level connectivity check ("Test
// connection" + the per-key Test button), as opposed to test-model.test.ts's
// per-MODEL testModel()/probeEndpoint() seam. Verifies:
//   - the base default GETs ctx.url (the model-list endpoint) and reports
//     ok/status/ms/sample from the real response, no dummy stub,
//   - it treats 2xx AND 3xx as reachable (wider than AdapterHttpResponse.ok),
//   - a bespoke override (mirrors example-custom.ts's synthetic-success case)
//     replaces the default entirely and never touches ctx.request().

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAICompatibleAdapter,
  composeUrl,
  type TestProviderCtx,
  type TestProviderResult,
  type AdapterHttpResponse,
} from "./base";
import type { Provider } from "../types";
import { openaiCodex } from "./catalog/openai-codex";
import {
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexUserAgent,
} from "./codex";

const provider = (): Provider =>
  ({
    id: "p",
    catalogId: "custom",
    format: "openai",
    nativeConversion: false,
    endpoints: [],
    basePath: "",
    modelsPath: "/v1/models",
    baseUrl: "https://api.example.com",
  }) as unknown as Provider;

function fakeCtx(
  reply: Partial<AdapterHttpResponse> & { json?: () => unknown },
  overrides: Partial<TestProviderCtx> = {},
): { ctx: TestProviderCtx; calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = [];
  const p = provider();
  const resolve = (target?: string) =>
    composeUrl(p.baseUrl, "", target ?? "/v1/models");
  const ctx: TestProviderCtx = {
    provider: p,
    baseUrl: p.baseUrl,
    basePath: "",
    resolve,
    url: resolve(),
    headers: { authorization: "Bearer sk-test" },
    apiKey: "sk-test",
    request: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        ms: 3,
        text: "",
        json: () => ({}),
        ...reply,
      };
    },
    ...overrides,
  };
  return { ctx, calls };
}

const plainAdapter = () =>
  new OpenAICompatibleAdapter({
    id: "plain",
    label: "Plain",
    blurb: "t",
    brand: "openai",
    defaults: { format: "openai", endpoints: ["chat"] },
    fields: [],
  });

test("default testProvider() GETs ctx.url and reports a real 2xx result", async () => {
  const { ctx, calls } = fakeCtx({ status: 200, ok: true, text: "hello" });
  const result = await plainAdapter().testProvider(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/models");
  assert.equal((calls[0].init as { method: string }).method, "GET");
  assert.deepEqual(
    (calls[0].init as { headers: Record<string, string> }).headers,
    ctx.headers,
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.sample, "hello");
});

test("default testProvider() treats a 3xx as reachable (matches the historical connectivity-test behavior)", async () => {
  const { ctx } = fakeCtx({ status: 302, ok: false, text: "" });
  const result = await plainAdapter().testProvider(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.status, 302);
});

test("default testProvider() reports a 4xx/5xx as unreachable", async () => {
  const { ctx } = fakeCtx({ status: 401, ok: false, text: "unauthorized" });
  const result = await plainAdapter().testProvider(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.sample, "unauthorized");
});

test("default testProvider() truncates a long body to 240 chars for `sample`", async () => {
  const long = "x".repeat(500);
  const { ctx } = fakeCtx({ status: 200, ok: true, text: long });
  const result = await plainAdapter().testProvider(ctx);
  assert.equal(result.sample?.length, 240);
});

test("a bespoke testProvider() override replaces the default and never calls ctx.request()", async () => {
  class SyntheticAdapter extends OpenAICompatibleAdapter {
    async testProvider(c: TestProviderCtx): Promise<TestProviderResult> {
      return { ok: true, status: 200, ms: 1, sample: "synthetic OK" };
    }
  }
  const adapter = new SyntheticAdapter({
    id: "synthetic",
    label: "Synthetic",
    blurb: "t",
    brand: "openai",
    defaults: { format: "openai", endpoints: ["chat"] },
    fields: [],
  });
  const { ctx, calls } = fakeCtx({ status: 500, ok: false, text: "" });
  const result = await adapter.testProvider(ctx);
  assert.equal(calls.length, 0); // the override never touched ctx.request
  assert.equal(result.ok, true);
  assert.equal(result.sample, "synthetic OK");
});

test("Codex testProvider GETs the versioned models endpoint with full identity", async () => {
  const calls: Array<{
    url: string;
    init: {
      method?: "GET" | "POST";
      headers: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    };
  }> = [];
  const codexProvider = {
    ...provider(),
    id: "codex",
    catalogId: "openai-codex",
    baseUrl: "https://chatgpt.com",
    basePath: "/backend-api/codex",
    modelsPath: "/models",
    endpoints: ["responses"],
  } as unknown as Provider;
  const resolve = (target?: string) =>
    composeUrl(
      codexProvider.baseUrl,
      codexProvider.basePath ?? "",
      target ?? "/models",
    );
  const ctx: TestProviderCtx = {
    provider: codexProvider,
    baseUrl: codexProvider.baseUrl,
    basePath: codexProvider.basePath ?? "",
    resolve,
    url: resolve(),
    headers: {
      authorization: "Bearer stale-bearer",
      Originator: "stale-originator",
      VERSION: "0.0.0",
      "user-agent": "stale-agent",
      "chatgpt-account-id": "stale-account",
      "x-custom": "keep-me",
    },
    apiKey: "codex-access-token",
    keyMetadata: { accountId: "acct-123" },
    request: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 401,
        ok: false,
        ms: 7,
        text: "unauthorized",
        json: () => ({}),
      };
    },
  };

  const result = await openaiCodex.testProvider(ctx);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "chatgpt.com");
  assert.equal(url.pathname, "/backend-api/codex/models");
  assert.equal(url.searchParams.get("client_version"), CODEX_CLIENT_VERSION);
  assert.equal(calls[0].init.method, "GET");
  const headers = calls[0].init.headers;
  assert.equal(headers["originator"], CODEX_ORIGINATOR);
  assert.equal(headers["version"], CODEX_CLIENT_VERSION);
  assert.equal(headers["user-agent"], codexUserAgent());
  assert.equal(headers["authorization"], "Bearer codex-access-token");
  assert.equal(headers["chatgpt-account-id"], "acct-123");
  assert.equal(headers["accept"], "application/json");
  assert.equal(headers["x-custom"], "keep-me");
  assert.equal(headers["Originator"], undefined);
  assert.equal(headers["VERSION"], undefined);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.ms, 7);
  assert.equal(result.sample, "unauthorized");
});
