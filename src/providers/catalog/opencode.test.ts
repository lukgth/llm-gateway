// OpenCode Zen adapter tests: canonical attribution headers on the Chat
// build, with a fake transport-free BuildCtx (no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { opencode } from "./opencode";
import { OPENCODE_CLIENT, withOpenCodeAttribution } from "../opencode";
import { extractCacheKey } from "../../formats/session-id";
import { WireKind } from "../../types";
import type { BuildCtx } from "../base";

const PROVIDER = {
  id: "opencode-provider",
  name: "OpenCode Zen",
  baseUrl: "https://opencode.ai/zen",
  basePath: "",
  endpoints: [WireKind.Chat] as WireKind[],
  authScheme: "bearer" as const,
  format: null,
  host: "opencode.ai",
  tlsVerify: true,
  extraHeaders: {},
  proxy: null,
  enabled: true,
  catalogId: "opencode",
};

function buildCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  return {
    provider: PROVIDER as never,
    model: "m",
    body: { model: "m", user: "session-a" },
    apiKey: "zen-key",
    keyMetadata: {},
    clientFmt: WireKind.Chat,
    providerFmt: WireKind.Chat,
    endpointKind: WireKind.Chat,
    forwardPath: "/chat/completions",
    baseUrl: PROVIDER.baseUrl,
    basePath: PROVIDER.basePath,
    resolve: ((target?: unknown) =>
      `${PROVIDER.baseUrl}${typeof target === "string" ? target : ""}`) as never,
    url: `${PROVIDER.baseUrl}/chat/completions`,
    headers: {
      authorization: "Bearer zen-key",
      "content-type": "application/json",
      accept: "application/json",
      "x-custom": "keep-me",
    },
    ...overrides,
  };
}

test("zen chat build emits cli client + body-derived session and preserves headers/body/url", () => {
  const body = { model: "m", user: "session-a" };
  const headers = {
    authorization: "Bearer zen-key",
    "content-type": "application/json",
    accept: "application/json",
    "x-custom": "keep-me",
  };
  const ctx = buildCtx({ body: { ...body }, headers: { ...headers } });
  const origHeaders = { ...ctx.headers };
  const built = opencode.chatCompletions(ctx);

  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-opencode-client"], OPENCODE_CLIENT);
  assert.equal(built.headers["x-opencode-session"], extractCacheKey(body));
  assert.ok(built.headers["x-opencode-session"]);
  assert.equal(built.headers["authorization"], "Bearer zen-key");
  assert.equal(built.headers["x-custom"], "keep-me");
  assert.equal(built.url, `${PROVIDER.baseUrl}/chat/completions`);
  assert.deepEqual(built.body, body);
  // Input map untouched (new map returned).
  assert.deepEqual(ctx.headers, origHeaders);
  assert.equal(ctx.headers["x-opencode-session"], undefined);
  assert.equal(ctx.headers["x-opencode-client"], undefined);
});

test("zen chat build goes through the buildFor seam", () => {
  const ctx = buildCtx();
  const built = opencode.buildFor(WireKind.Chat, ctx);
  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-opencode-session"], extractCacheKey(ctx.body));
});

test("conflicting case variants are replaced by canonical values, supplied session retained", () => {
  const ctx = buildCtx({
    body: { model: "m", user: "session-a" },
    headers: {
      authorization: "Bearer zen-key",
      "X-OpenCode-Session": "caller-session",
      "X-OPENCODE-CLIENT": "evil-client",
      "x-Opencode-Session": "ignored-duplicate",
      "x-custom": "keep-me",
      "content-type": "application/json",
    },
  });
  const built = opencode.chatCompletions(ctx);
  const sessionKeys = Object.keys(built.headers).filter(
    (k) => k.toLowerCase() === "x-opencode-session",
  );
  const clientKeys = Object.keys(built.headers).filter(
    (k) => k.toLowerCase() === "x-opencode-client",
  );
  assert.deepEqual(sessionKeys, ["x-opencode-session"]);
  assert.deepEqual(clientKeys, ["x-opencode-client"]);
  assert.equal(built.headers["x-opencode-session"], "caller-session");
  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-custom"], "keep-me");
});

test("missing identity falls back to the stable gateway session, never empty", () => {
  const body = { model: "m" };
  const built = opencode.chatCompletions(buildCtx({ body: { ...body } }));
  assert.equal(built.headers["x-opencode-session"], "gw-0bef5d67");
  assert.equal(built.headers["x-opencode-session"], extractCacheKey(body));
  assert.ok(built.headers["x-opencode-session"]);
  assert.equal(built.headers["x-opencode-client"], "cli");

  // Same fallback through the shared helper directly.
  const direct = withOpenCodeAttribution(
    { authorization: "Bearer zen-key" },
    { model: "m" },
  );
  assert.equal(direct["x-opencode-session"], "gw-0bef5d67");
  assert.equal(direct["x-opencode-client"], "cli");
});
