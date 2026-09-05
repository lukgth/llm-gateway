// OpenAI Codex adapter tests: exact template defaults, Responses preference,
// Codex identity header pinning, body normalization, and model-list parsing -
// all with a fake transport, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiCodex } from "./openai-codex";
import {
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexUserAgent,
} from "../codex";
import { WireKind } from "../../types";
import type { BuildCtx, ModelsCtx } from "../base";

const PROVIDER = {
  id: "openai-codex-provider",
  name: "OpenAI Codex",
  baseUrl: "https://chatgpt.com",
  basePath: "/backend-api/codex",
  modelsPath: "/models",
  endpoints: [WireKind.Responses, WireKind.Chat] as WireKind[],
  authScheme: "bearer" as const,
  format: null,
  host: "chatgpt.com",
  tlsVerify: true,
  extraHeaders: {},
  proxy: null,
  enabled: true,
  catalogId: "openai-codex",
};

function buildCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  return {
    provider: PROVIDER as never,
    model: "gpt-5-codex",
    body: { model: "gpt-5-codex", stream: false },
    apiKey: "codex-access-token",
    keyMetadata: { accountId: "acct-123" },
    clientFmt: WireKind.Responses,
    providerFmt: WireKind.Responses,
    endpointKind: WireKind.Responses,
    forwardPath: "/responses",
    baseUrl: PROVIDER.baseUrl,
    basePath: PROVIDER.basePath,
    resolve: ((target?: unknown) =>
      `${PROVIDER.baseUrl}${PROVIDER.basePath}${
        typeof target === "string" ? target : ""
      }`) as never,
    url: `${PROVIDER.baseUrl}${PROVIDER.basePath}/responses`,
    headers: {
      authorization: "Bearer codex-access-token",
      "content-type": "application/json",
      accept: "application/json",
    },
    ...overrides,
  };
}

test("openai-codex template pins the Codex backend and import authentication", () => {
  const tpl = openaiCodex.toTemplate();
  assert.equal(tpl.id, "openai-codex");
  assert.equal(tpl.label, "OpenAI Codex");
  assert.equal(tpl.brand, "openai");
  assert.equal(tpl.defaults.baseUrl, "https://chatgpt.com");
  assert.equal(tpl.defaults.basePath, "/backend-api/codex");
  assert.equal(tpl.defaults.modelsPath, "/models");
  assert.deepEqual(tpl.defaults.endpoints, [WireKind.Responses, WireKind.Chat]);
  assert.equal(tpl.defaults.authScheme, "bearer");
  assert.equal(tpl.defaults.nativeConversion, false);
  assert.equal(tpl.supportsOAuth, true);
  assert.deepEqual(tpl.authentication, {
    kind: "oauth",
    flow: "import",
    title: "Connect OpenAI Codex",
    description: "Import Codex auth.json or a ChatGPT session cookie.",
    actionLabel: "Import Codex credentials",
  });
  // No API-key field; baseUrl is pinned non-editable.
  assert.equal(tpl.fields.some((f) => f.key === "apiKeys"), false);
  const base = tpl.fields.find((f) => f.key === "baseUrl");
  assert.ok(base);
  assert.equal(base.editable, false);
});


test("preferredEndpoint always prefers Responses (route-level guard filters unaccepted kinds)", () => {
  assert.equal(
    openaiCodex.preferredEndpoint("gpt-5-codex", [
      WireKind.Responses,
      WireKind.Chat,
    ]),
    WireKind.Responses,
  );
  // Unconditional preference - resolveKind only honors it when the provider
  // actually accepts responses.
  assert.equal(
    openaiCodex.preferredEndpoint("anything", [WireKind.Chat]),
    WireKind.Responses,
  );
  // A per-link pin still wins through routeFor.
  const pinned = openaiCodex.routeFor(
    WireKind.Chat,
    PROVIDER as never,
    "chat",
    "gpt-5-codex",
  );
  assert.equal(pinned.endpointKind, WireKind.Chat);
  // No pin -> Responses wins over the chat-native fallback ordering.
  const unpinned = openaiCodex.routeFor(
    WireKind.Responses,
    PROVIDER as never,
    null,
    "gpt-5-codex",
  );
  assert.equal(unpinned.endpointKind, WireKind.Responses);
});
test("responses build forces stream/store, normalizes instructions, and sets identity headers", () => {
  const ctx = buildCtx({
    body: {
      model: "gpt-5-codex",
      input: [],
      stream: false,
      max_output_tokens: 100,
      max_tokens: 101,
      max_completion_tokens: 102,
    } as BuildCtx["body"],
    headers: {
      authorization: "Bearer codex-access-token",
      "content-type": "application/json",
    },
  });
  const built = openaiCodex.responses(ctx);
  assert.equal(built.body["stream"], true);
  assert.equal(built.body["store"], false);
  assert.equal(built.body["instructions"], "");
  assert.deepEqual(built.body["input"], []);
  assert.equal("max_output_tokens" in built.body, false);
  assert.equal("max_tokens" in built.body, false);
  assert.equal("max_completion_tokens" in built.body, false);
  assert.equal(built.headers["originator"], CODEX_ORIGINATOR);
  assert.equal(built.headers["version"], CODEX_CLIENT_VERSION);
  assert.equal(built.headers["user-agent"], codexUserAgent());
  assert.equal(built.headers["authorization"], "Bearer codex-access-token");
  assert.equal(built.headers["chatgpt-account-id"], "acct-123");
});

test("responses build wraps bare-string input in a Responses message list", () => {
  const ctx = buildCtx({
    body: {
      model: "gpt-5-codex",
      input: "Reply with exactly: hi",
    } as BuildCtx["body"],
  });
  const built = openaiCodex.responses(ctx);
  assert.equal(built.body["stream"], true);
  assert.deepEqual(built.body["input"], [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply with exactly: hi" }],
    },
  ]);
  assert.equal(built.body["store"], false);
  assert.equal(built.body["instructions"], "");
});

test("chat build preserves an existing string instructions value", () => {
  const ctx = buildCtx({
    body: {
      model: "m",
      instructions: "be brief",
      store: true,
      max_output_tokens: 100,
      max_tokens: 101,
      max_completion_tokens: 102,
    },
    endpointKind: WireKind.Chat,
    providerFmt: WireKind.Chat,
    clientFmt: WireKind.Chat,
    url: `${PROVIDER.baseUrl}${PROVIDER.basePath}/chat/completions`,
  });
  const built = openaiCodex.chatCompletions(ctx);
  assert.equal(built.body["instructions"], "be brief");
  assert.equal("max_output_tokens" in built.body, false);
  assert.equal("max_tokens" in built.body, false);
  assert.equal("max_completion_tokens" in built.body, false);
  assert.equal(built.headers["chatgpt-account-id"], "acct-123");
});

test("conflicting case variants of owned headers are replaced by canonical values", () => {
  const ctx = buildCtx({
    headers: {
      AUTHORIZATION: "Bearer client-secret",
      Originator: "evil-client",
      VERSION: "9.9.9",
      "USER-AGENT": "evil-agent/1.0",
      "ChatGPT-Account-Id": "attacker-acct",
      "x-custom": "keep-me",
      "content-type": "application/json",
    },
  });
  const built = openaiCodex.responses(ctx);
  assert.equal(built.headers["AUTHORIZATION"], undefined);
  assert.equal(built.headers["Originator"], undefined);
  assert.equal(built.headers["VERSION"], undefined);
  assert.equal(built.headers["USER-AGENT"], undefined);
  assert.equal(built.headers["ChatGPT-Account-Id"], undefined);
  assert.equal(Object.keys(built.headers).includes("Authorization"), false);
  assert.equal(built.headers["originator"], CODEX_ORIGINATOR);
  assert.equal(built.headers["user-agent"], codexUserAgent());
  assert.equal(built.headers["chatgpt-account-id"], "acct-123");
  assert.equal(built.headers["authorization"], "Bearer codex-access-token");
  assert.equal(built.headers["x-custom"], "keep-me");
});

test("missing account metadata omits the account header instead of sending a blank one", () => {
  const ctx = buildCtx({ keyMetadata: {} });
  const built = openaiCodex.responses(ctx);
  assert.equal(built.headers["chatgpt-account-id"], undefined);
});

test("fetchModels requests the versioned models path with identity headers and filters public models", async () => {
  const calls: Array<{ url: string; init: { headers: Record<string, string> } }> =
    [];
  const transport = (async (
    url: string,
    init: { headers: Record<string, string> },
  ) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { slug: "gpt-5.2-codex", display_name: "GPT-5.2 Codex", visibility: "list" },
          { slug: "internal-only", display_name: "Internal", visibility: "hide" },
          { slug: "api-disabled", supported_in_api: false },
          { slug: "plain-visible" },
        ],
      }),
    };
  }) as never;
  const ctx: ModelsCtx = {
    provider: PROVIDER as never,
    baseUrl: PROVIDER.baseUrl,
    basePath: PROVIDER.basePath,
    modelsPath: "/models",
    resolve: ((target?: unknown) =>
      `${PROVIDER.baseUrl}${PROVIDER.basePath}${
        typeof target === "string" ? target : "/models"
      }`) as never,
    url: `${PROVIDER.baseUrl}${PROVIDER.basePath}/models`,
    headers: { authorization: "Bearer codex-access-token" },
    apiKey: "codex-access-token",
    keyMetadata: { accountId: "acct-123" },
    format: "openai",
    transport,
  };
  const models = await openaiCodex.fetchModels(ctx);
  assert.match(
    calls[0].url,
    new RegExp(`^${PROVIDER.baseUrl.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/backend-api/codex/models\\?client_version=${CODEX_CLIENT_VERSION}$`),
  );
  assert.equal(calls[0].init.headers["originator"], CODEX_ORIGINATOR);
  assert.equal(calls[0].init.headers["user-agent"], codexUserAgent());
  assert.equal(calls[0].init.headers["authorization"], "Bearer codex-access-token");
  assert.equal(calls[0].init.headers["chatgpt-account-id"], "acct-123");
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-5.2-codex", "plain-visible"],
  );
  assert.equal(models[0]?.displayName, "GPT-5.2 Codex");
});

test("fetchModels fails closed on non-2xx, malformed bodies, and empty lists", async () => {
  const makeTransport = (body: () => unknown) =>
    (async (url: string) => ({
      ok: true,
      status: 200,
      json: body,
    })) as never;
  const failTransport = (async () => ({
    ok: false,
    status: 403,
    json: async () => ({}),
  })) as never;
  const baseCtx = (): ModelsCtx => ({
    provider: PROVIDER as never,
    baseUrl: PROVIDER.baseUrl,
    basePath: PROVIDER.basePath,
    modelsPath: "/models",
    resolve: (() => `${PROVIDER.baseUrl}${PROVIDER.basePath}/models`) as never,
    url: `${PROVIDER.baseUrl}${PROVIDER.basePath}/models`,
    headers: {},
    apiKey: "k",
    keyMetadata: {},
    format: "openai",
    transport: failTransport,
  });

  await assert.rejects(() => openaiCodex.fetchModels(baseCtx()), /403/);

  for (const body of [
    () => ({ models: "nope" }),
    () => ({}),
    () => ({ models: [] }),
  ]) {
    await assert.rejects(() =>
      openaiCodex.fetchModels({
        ...baseCtx(),
        transport: makeTransport(body),
      }),
    );
  }
});
