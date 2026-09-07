// OpenCode Zen adapter tests: canonical attribution headers on the Chat and
// Responses builds, with a fake transport-free BuildCtx (no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { opencode } from "./opencode";
import {
  OPENCODE_CLIENT,
  OPENCODE_FALLBACK_SESSION_ID,
  OPENCODE_USER_AGENT,
  openCodeSessionFromBody,
  withOpenCodeAttribution,
} from "../opencode";
import type {
  TaggedRequestTransform,
  TransformCtx,
} from "../../formats/pipeline";
import { messagesRequestToChat } from "../../formats/converters/chat-messages/request";
import type { Provider } from "../../types";
import { WireKind } from "../../types";
import type { BuildCtx } from "../base";

// Every gateway-derived session AND request id must be a lowercase UUID;
// only an explicit caller-supplied header may be non-UUID (it is forwarded
// verbatim).
const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(body),
  );
  assert.match(built.headers["x-opencode-session"], SESSION_UUID_RE);
  assert.ok(built.headers["x-opencode-session"]);
  // Deterministic per-conversation request id, same shape as the session
  // (stability across rebuilds is asserted in the buildFor seam test).
  assert.match(built.headers["x-opencode-request"], SESSION_UUID_RE);
  assert.ok(built.headers["x-opencode-request"]);
  assert.equal(built.headers["user-agent"], OPENCODE_USER_AGENT);
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
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(ctx.body),
  );
  // A retry rebuilds the same request id for the same conversation.
  assert.equal(
    built.headers["x-opencode-request"],
    opencode.buildFor(WireKind.Chat, ctx).headers["x-opencode-request"],
  );
});

test("conflicting case variants are replaced by canonical values, supplied session retained", () => {
  const ctx = buildCtx({
    body: { model: "m", user: "session-a" },
    headers: {
      authorization: "Bearer zen-key",
      "X-OpenCode-Session": "caller-session",
      "X-OpenCode-Request": "caller-request",
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
  const requestKeys = Object.keys(built.headers).filter(
    (k) => k.toLowerCase() === "x-opencode-request",
  );
  assert.deepEqual(sessionKeys, ["x-opencode-session"]);
  assert.deepEqual(clientKeys, ["x-opencode-client"]);
  assert.deepEqual(requestKeys, ["x-opencode-request"]);
  assert.equal(built.headers["x-opencode-session"], "caller-session");
  assert.equal(built.headers["x-opencode-request"], "caller-request");
  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-custom"], "keep-me");
});

test("missing identity falls back to the stable gateway session, never empty", () => {
  const body = { model: "m" };
  const built = opencode.chatCompletions(buildCtx({ body: { ...body } }));
  assert.equal(
    built.headers["x-opencode-session"],
    OPENCODE_FALLBACK_SESSION_ID,
  );
  assert.match(built.headers["x-opencode-session"], SESSION_UUID_RE);
  assert.ok(built.headers["x-opencode-session"]);
  assert.match(built.headers["x-opencode-request"], SESSION_UUID_RE);
  assert.ok(built.headers["x-opencode-request"]);
  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["user-agent"], OPENCODE_USER_AGENT);

  // Same fallback through the shared helper directly.
  const direct = withOpenCodeAttribution(
    { authorization: "Bearer zen-key" },
    { model: "m" },
  );
  assert.equal(direct["x-opencode-session"], OPENCODE_FALLBACK_SESSION_ID);
  assert.equal(direct["x-opencode-client"], "cli");
});

test("zen responses build emits the same attribution and preserves headers/body/url", () => {
  const body = { model: "m", user: "session-a" };
  const headers = {
    authorization: "Bearer zen-key",
    "content-type": "application/json",
    accept: "application/json",
    "x-custom": "keep-me",
  };
  const ctx = buildCtx({
    clientFmt: WireKind.Responses,
    providerFmt: WireKind.Responses,
    endpointKind: WireKind.Responses,
    forwardPath: "/responses",
    url: `${PROVIDER.baseUrl}/responses`,
    body: { ...body },
    headers: { ...headers },
  });
  const built = opencode.responses(ctx);

  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-opencode-client"], OPENCODE_CLIENT);
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(body),
  );
  assert.match(built.headers["x-opencode-session"], SESSION_UUID_RE);
  assert.match(built.headers["x-opencode-request"], SESSION_UUID_RE);
  assert.equal(built.headers["user-agent"], OPENCODE_USER_AGENT);
  assert.equal(built.headers["authorization"], "Bearer zen-key");
  assert.equal(built.headers["x-custom"], "keep-me");
  assert.equal(built.url, `${PROVIDER.baseUrl}/responses`);
  assert.deepEqual(built.body, body);
});

test("zen catalog advertises chat + responses endpoints", () => {
  const template = opencode.toTemplate();
  assert.deepEqual(template.defaults.endpoints, [
    WireKind.Chat,
    WireKind.Responses,
  ]);
});

// --- pre-conversion session stamping (opencode:session request stages) -----

const STAMP_PROVIDER = PROVIDER as unknown as Provider;

function transformCtx(
  headers: Record<string, string>,
  clientFmt: WireKind = WireKind.Chat,
): TransformCtx {
  return {
    provider: STAMP_PROVIDER,
    clientFmt,
    providerFmt: WireKind.Chat,
    headers,
  };
}

// Run the stage matching the client format, then the build. Mirrors the real
// hop: buildTransformPlan picks exactly one `opencode:session` stage by tag,
// then chatCompletions canonicalizes.
function stampAndBuild(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  clientFmt: WireKind = WireKind.Chat,
): Record<string, string> {
  const stages = opencode.requestTransforms(STAMP_PROVIDER);
  assert.deepEqual(
    stages.map((s) => s.name),
    [
      "opencode:session",
      "opencode:session",
      "opencode:session",
    ],
  );
  const stage = (stages as TaggedRequestTransform[]).find(
    (s) => s.format === clientFmt,
  );
  assert.ok(stage, `no opencode:session stage tagged ${clientFmt}`);
  const stamped = { ...headers };
  applyStage(stage, { ...body }, transformCtx(stamped, clientFmt));
  return withOpenCodeAttribution(stamped, body);
}

function applyStage(
  stage: TaggedRequestTransform,
  body: Record<string, unknown>,
  ctx: TransformCtx,
): void {
  stage.apply(body, ctx);
}

test("caller-supplied session header wins verbatim even when non-UUID", () => {
  const out = stampAndBuild(
    { model: "m", user: "someone-else" },
    { authorization: "Bearer zen-key", "X-OpenCode-Session": "caller-session" },
  );
  assert.equal(out["x-opencode-session"], "caller-session");
});

test("messages-client identity survives messages->chat conversion", () => {
  const original: Record<string, unknown> = {
    model: "m",
    max_tokens: 64,
    metadata: {
      user_id: JSON.stringify({
        session_id: "s-1",
        device_id: "d",
        account_uuid: "a",
      }),
    },
    messages: [{ role: "user", content: "hello" }],
  };

  // The lossy hop this change exists for: messages->chat drops
  // metadata.user_id entirely.
  const converted = messagesRequestToChat(original as never);
  assert.equal("metadata" in converted, false);
  assert.equal(openCodeSessionFromBody(converted), undefined);

  // Real-order hop: pre-conversion stamp on the messages body, convert,
  // canonicalize - the session must match the ORIGINAL body's identity.
  const out = stampAndBuild(original, {}, WireKind.Messages);
  assert.equal(out["x-opencode-session"], openCodeSessionFromBody(original));
  assert.match(out["x-opencode-session"], SESSION_UUID_RE);
  assert.notEqual(out["x-opencode-session"], OPENCODE_FALLBACK_SESSION_ID);

  // Per-conversation stability: a second turn whose message list grew still
  // hashes to the same session.
  const turn2 = {
    ...original,
    messages: [
      ...(original.messages as unknown[]),
      { role: "user", content: "and again" },
    ],
  };
  assert.equal(
    stampAndBuild(turn2, {}, WireKind.Messages)["x-opencode-session"],
    openCodeSessionFromBody(original),
  );
});

test("raw-string metadata.user_id (chat->messages carry shape) derives a session", () => {
  const body: Record<string, unknown> = {
    model: "m",
    max_tokens: 64,
    metadata: { user_id: "user-123" },
    messages: [{ role: "user", content: "hello" }],
  };
  const out = stampAndBuild(body, {}, WireKind.Messages);
  assert.equal(out["x-opencode-session"], openCodeSessionFromBody(body));
  assert.match(out["x-opencode-session"], SESSION_UUID_RE);
});

test("responses-client user field derives a session", () => {
  const body: Record<string, unknown> = { model: "m", user: "resp-user" };
  const out = stampAndBuild(body, {}, WireKind.Responses);
  assert.equal(
    out["x-opencode-session"],
    openCodeSessionFromBody({ user: "resp-user" }),
  );
  assert.match(out["x-opencode-session"], SESSION_UUID_RE);
});

test("derived sessions are deterministic and identity-separating", () => {
  const a1 = openCodeSessionFromBody({ user: "a" });
  const a2 = openCodeSessionFromBody({ user: "a" });
  const b = openCodeSessionFromBody({ user: "b" });
  assert.ok(a1 && a2 && b);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, SESSION_UUID_RE);
  assert.match(b, SESSION_UUID_RE);
});

test("no identity anywhere: stage is a no-op and build applies the fallback UUID", () => {
  const stamped: Record<string, string> = {};
  const stages = opencode.requestTransforms(STAMP_PROVIDER);
  const stage = (stages as TaggedRequestTransform[]).find(
    (s) => s.format === WireKind.Chat,
  );
  assert.ok(stage);
  applyStage(stage, { model: "m" }, transformCtx(stamped));
  assert.deepEqual(stamped, {});
  const out = withOpenCodeAttribution(stamped, { model: "m" });
  assert.equal(out["x-opencode-session"], OPENCODE_FALLBACK_SESSION_ID);
  assert.equal(out["x-opencode-client"], "cli");
});
