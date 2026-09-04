// OpenCode Go adapter tests: canonical attribution headers on both Chat
// and Messages builds, with a fake transport-free BuildCtx (no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { opencodeGo } from "./opencode-go";
import { OPENCODE_CLIENT } from "../opencode";
import { extractCacheKey } from "../../formats/session-id";
import { WireKind } from "../../types";
import type { BuildCtx } from "../base";

const PROVIDER = {
  id: "opencode-go-provider",
  name: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go",
  basePath: "",
  endpoints: [WireKind.Chat, WireKind.Messages] as WireKind[],
  authScheme: "bearer" as const,
  format: null,
  host: "opencode.ai",
  tlsVerify: true,
  extraHeaders: {},
  proxy: null,
  enabled: true,
  catalogId: "opencode-go",
};

function buildCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  return {
    provider: PROVIDER as never,
    model: "m",
    body: { model: "m", user: "session-a" },
    apiKey: "go-key",
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
      authorization: "Bearer go-key",
      "content-type": "application/json",
      accept: "application/json",
      "x-custom": "keep-me",
    },
    ...overrides,
  };
}

function messagesCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  return buildCtx({
    clientFmt: WireKind.Messages,
    providerFmt: WireKind.Messages,
    endpointKind: WireKind.Messages,
    forwardPath: "/messages",
    url: `${PROVIDER.baseUrl}/messages`,
    body: { model: "m", user: "session-a" },
    ...overrides,
  });
}

test("go chat build emits cli client + body-derived session and preserves headers/body/url", () => {
  const body = { model: "m", user: "session-a" };
  const ctx = buildCtx({ body: { ...body } });
  const built = opencodeGo.chatCompletions(ctx);

  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-opencode-client"], OPENCODE_CLIENT);
  assert.equal(built.headers["x-opencode-session"], extractCacheKey(body));
  assert.ok(built.headers["x-opencode-session"]);
  assert.equal(built.headers["authorization"], "Bearer go-key");
  assert.equal(built.headers["x-custom"], "keep-me");
  assert.equal(built.url, `${PROVIDER.baseUrl}/chat/completions`);
  assert.deepEqual(built.body, body);
});

test("go messages build emits the same attribution and preserves headers/body/url", () => {
  const body = { model: "m", user: "session-a" };
  const ctx = messagesCtx({ body: { ...body } });
  const built = opencodeGo.messages(ctx);

  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-opencode-session"], extractCacheKey(body));
  assert.equal(built.headers["authorization"], "Bearer go-key");
  assert.equal(built.headers["x-custom"], "keep-me");
  assert.equal(built.url, `${PROVIDER.baseUrl}/messages`);
  assert.deepEqual(built.body, body);
});

test("go chat + messages builds go through the buildFor seam", () => {
  const chat = opencodeGo.buildFor(WireKind.Chat, buildCtx());
  assert.equal(chat.headers["x-opencode-client"], "cli");
  assert.ok(chat.headers["x-opencode-session"]);

  const messages = opencodeGo.buildFor(WireKind.Messages, messagesCtx());
  assert.equal(messages.headers["x-opencode-client"], "cli");
  assert.equal(
    messages.headers["x-opencode-session"],
    extractCacheKey({ model: "m", user: "session-a" }),
  );
});

test("conflicting case variants are replaced by canonical values, supplied session retained", () => {
  const headers = {
    authorization: "Bearer go-key",
    "X-OpenCode-Session": "caller-session",
    "X-OPENCODE-CLIENT": "evil-client",
    "x-Opencode-Client": "ignored-duplicate",
    "x-custom": "keep-me",
    "content-type": "application/json",
  };
  for (const built of [
    opencodeGo.chatCompletions(buildCtx({ headers: { ...headers } })),
    opencodeGo.messages(messagesCtx({ headers: { ...headers } })),
  ]) {
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
  }
});

test("missing identity falls back to the stable gateway session, never empty", () => {
  const body = { model: "m" };
  for (const built of [
    opencodeGo.chatCompletions(buildCtx({ body: { ...body } })),
    opencodeGo.messages(messagesCtx({ body: { ...body } })),
  ]) {
    assert.equal(built.headers["x-opencode-session"], "gw-0bef5d67");
    assert.equal(built.headers["x-opencode-session"], extractCacheKey(body));
    assert.ok(built.headers["x-opencode-session"]);
    assert.equal(built.headers["x-opencode-client"], "cli");
  }
});
