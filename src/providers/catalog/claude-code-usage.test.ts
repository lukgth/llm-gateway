// Claude Code passive key-usage reporting: keyUsage() reads the last
// passively-captured response headers (ctx.unifiedUsage), never makes a
// live proactive call for this path. Two credential shapes send two
// different header families, and keyUsage() must handle both:
//   - an OAuth-authenticated request -> anthropic-ratelimit-unified-* (the
//     subscription-billing scheme)
//   - a legacy plain sk-ant-api03-... key migrated onto this catalog before
//     OAuth-only import existed -> the STANDARD anthropic-ratelimit-*
//     headers (the same ones a plain pay-as-you-go Anthropic API key sends)
//
// This is deliberately scoped to the claude-code adapter only - the base
// AnthropicCompatibleAdapter class and the official "anthropic" catalog do
// NOT get key-usage reporting at all (Anthropic's plain API has no
// meaningful usage view worth showing); see providers/base/adapter.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCode } from "./claude-code";
import type { UsageCtx } from "../base";
import { WireKind } from "../../types";

const PROVIDER = {
  id: "claude-code-provider",
  name: "Claude Code",
  baseUrl: "https://api.anthropic.com",
  basePath: "",
  modelsPath: "/v1/models",
  endpoints: [WireKind.Messages] as WireKind[],
  authScheme: "bearer" as const,
  format: null,
  host: "api.anthropic.com",
  tlsVerify: true,
  extraHeaders: {},
  proxy: null,
  enabled: true,
  catalogId: "claude-code",
};

function usageCtx(over: Partial<UsageCtx> = {}): UsageCtx {
  return {
    provider: PROVIDER as never,
    keyMetadata: {},
    apiKey: "sk-ant-oat01-access-token",
    mask: "sk-ant…oken",
    enabled: true,
    seed: 1,
    baseUrl: "https://api.anthropic.com",
    basePath: "",
    resolve: (t) =>
      "https://api.anthropic.com" + (typeof t === "string" ? t : ""),
    request: async () => ({
      status: 200,
      ok: true,
      ms: 1,
      text: "",
      json: () => ({}),
    }),
    ...over,
  } as UsageCtx;
}

test("supportsKeyUsage is true for claude-code", () => {
  assert.equal(claudeCode.supportsKeyUsage(usageCtx()), true);
});

test("keyUsage reads unified headers for an OAuth-authenticated key", async () => {
  const result = await claudeCode.keyUsage(
    usageCtx({
      unifiedUsage: {
        headers: {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.2",
        },
        httpStatus: 200,
        capturedAt: new Date().toISOString(),
      },
    }),
  );
  assert.equal(result.dummy, false);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].id, "unified-5h");
  assert.equal(result.windows[0].used, 20);
});

test("keyUsage falls back to standard headers for a legacy plain-API-key credential", async () => {
  const result = await claudeCode.keyUsage(
    usageCtx({
      keyMetadata: { authKind: "api_key", tokenKind: "long_lived" },
      unifiedUsage: {
        headers: {
          "anthropic-ratelimit-requests-limit": "1000",
          "anthropic-ratelimit-requests-remaining": "950",
          "anthropic-ratelimit-tokens-limit": "100000",
          "anthropic-ratelimit-tokens-remaining": "80000",
        },
        httpStatus: 200,
        capturedAt: new Date().toISOString(),
      },
    }),
  );
  assert.equal(result.dummy, false);
  assert.equal(result.unavailable, undefined);
  const byId = Object.fromEntries(result.windows.map((w) => [w.id, w]));
  assert.equal(byId["standard-requests"].used, 50);
  assert.equal(byId["standard-requests"].limit, 1000);
  assert.equal(byId["standard-tokens"].used, 20000);
});

test("keyUsage reports unavailable when no usage has been captured yet", async () => {
  const result = await claudeCode.keyUsage(usageCtx({ unifiedUsage: null }));
  assert.equal(result.unavailable, true);
  assert.equal(result.windows.length, 0);
});

test("keyUsage reports unavailable when captured headers match neither family", async () => {
  const result = await claudeCode.keyUsage(
    usageCtx({
      unifiedUsage: {
        headers: { "content-type": "application/json" },
        httpStatus: 200,
        capturedAt: new Date().toISOString(),
      },
    }),
  );
  assert.equal(result.unavailable, true);
  assert.equal(result.windows.length, 0);
});
