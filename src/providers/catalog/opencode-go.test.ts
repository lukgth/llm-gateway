// OpenCode Go adapter tests: canonical attribution headers on the Chat,
// Messages, and Responses builds, with a fake transport-free BuildCtx (no
// network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { opencodeGo } from "./opencode-go";
import {
  OPENCODE_CLIENT,
  OPENCODE_FALLBACK_SESSION_ID,
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

// Every gateway-derived session must be a lowercase UUID; only an explicit
// caller-supplied header may be non-UUID (it is forwarded verbatim).
const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function responsesCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  return buildCtx({
    clientFmt: WireKind.Responses,
    providerFmt: WireKind.Responses,
    endpointKind: WireKind.Responses,
    forwardPath: "/responses",
    url: `${PROVIDER.baseUrl}/responses`,
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
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(body),
  );
  assert.match(built.headers["x-opencode-session"], SESSION_UUID_RE);
  assert.ok(built.headers["x-opencode-session"]);
  assert.match(built.headers["x-opencode-request"], SESSION_UUID_RE);
  assert.equal(built.headers["user-agent"], "opencode/1.18.29");
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
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(body),
  );
  assert.match(built.headers["x-opencode-request"], SESSION_UUID_RE);
  assert.equal(built.headers["authorization"], "Bearer go-key");
  assert.equal(built.headers["x-custom"], "keep-me");
  assert.equal(built.url, `${PROVIDER.baseUrl}/messages`);
  assert.deepEqual(built.body, body);
});

test("go responses build emits the same attribution and preserves headers/body/url", () => {
  const body = { model: "m", user: "session-a" };
  const ctx = responsesCtx({ body: { ...body } });
  const built = opencodeGo.responses(ctx);

  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-opencode-client"], OPENCODE_CLIENT);
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(body),
  );
  assert.match(built.headers["x-opencode-session"], SESSION_UUID_RE);
  assert.match(built.headers["x-opencode-request"], SESSION_UUID_RE);
  assert.equal(built.headers["user-agent"], "opencode/1.18.29");
  assert.equal(built.headers["authorization"], "Bearer go-key");
  assert.equal(built.headers["x-custom"], "keep-me");
  assert.equal(built.url, `${PROVIDER.baseUrl}/responses`);
  assert.deepEqual(built.body, body);
});

test("go chat + messages + responses builds go through the buildFor seam", () => {
  const chat = opencodeGo.buildFor(WireKind.Chat, buildCtx());
  assert.equal(chat.headers["x-opencode-client"], "cli");
  assert.ok(chat.headers["x-opencode-session"]);

  const messages = opencodeGo.buildFor(WireKind.Messages, messagesCtx());
  assert.equal(messages.headers["x-opencode-client"], "cli");
  assert.equal(
    messages.headers["x-opencode-session"],
    openCodeSessionFromBody({ model: "m", user: "session-a" }),
  );

  const responses = opencodeGo.buildFor(WireKind.Responses, responsesCtx());
  assert.equal(responses.headers["x-opencode-client"], "cli");
  assert.ok(responses.headers["x-opencode-session"]);
});

test("conflicting case variants are replaced by canonical values, supplied session retained", () => {
  const headers = {
    authorization: "Bearer go-key",
    "X-OpenCode-Session": "caller-session",
    "X-OpenCode-Request": "caller-request",
    "X-OPENCODE-CLIENT": "evil-client",
    "x-Opencode-Client": "ignored-duplicate",
    "x-custom": "keep-me",
    "content-type": "application/json",
  };
  for (const built of [
    opencodeGo.chatCompletions(buildCtx({ headers: { ...headers } })),
    opencodeGo.messages(messagesCtx({ headers: { ...headers } })),
    opencodeGo.responses(responsesCtx({ headers: { ...headers } })),
  ]) {
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
  }
});

test("missing identity falls back to the stable gateway session, never empty", () => {
  const body = { model: "m" };
  for (const built of [
    opencodeGo.chatCompletions(buildCtx({ body: { ...body } })),
    opencodeGo.messages(messagesCtx({ body: { ...body } })),
    opencodeGo.responses(responsesCtx({ body: { ...body } })),
  ]) {
    assert.equal(
      built.headers["x-opencode-session"],
      OPENCODE_FALLBACK_SESSION_ID,
    );
    assert.match(built.headers["x-opencode-session"], SESSION_UUID_RE);
    assert.ok(built.headers["x-opencode-session"]);
    assert.match(built.headers["x-opencode-request"], SESSION_UUID_RE);
    assert.equal(built.headers["x-opencode-client"], "cli");
  }
});

// --- pre-conversion session stamping (opencode:session request stages) -----

const STAMP_PROVIDER = PROVIDER as unknown as Provider;

function transformCtx(
  headers: Record<string, string>,
  clientFmt: WireKind,
): TransformCtx {
  return {
    provider: STAMP_PROVIDER,
    clientFmt,
    providerFmt: WireKind.Chat,
    headers,
  };
}

function applyStage(
  stage: TaggedRequestTransform,
  body: Record<string, unknown>,
  ctx: TransformCtx,
): void {
  stage.apply(body, ctx);
}

// Run the stage matching the client format, then the build. Mirrors the real
// hop: buildTransformPlan picks exactly one `opencode:session` stage by tag,
// then the build method canonicalizes.
function stampAndBuild(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  clientFmt: WireKind,
): Record<string, string> {
  const stages = opencodeGo.requestTransforms(STAMP_PROVIDER);
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

test("caller-supplied session header wins verbatim even when non-UUID", () => {
  const out = stampAndBuild(
    { model: "m", user: "someone-else" },
    { authorization: "Bearer go-key", "X-OpenCode-Session": "caller-session" },
    WireKind.Chat,
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
  // metadata.user_id, so no post-conversion derivation can recover it.
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
  const stages = opencodeGo.requestTransforms(STAMP_PROVIDER);
  const stage = (stages as TaggedRequestTransform[]).find(
    (s) => s.format === WireKind.Chat,
  );
  assert.ok(stage);
  applyStage(stage, { model: "m" }, transformCtx(stamped, WireKind.Chat));
  assert.deepEqual(stamped, {});
  const out = withOpenCodeAttribution(stamped, { model: "m" });
  assert.equal(out["x-opencode-session"], OPENCODE_FALLBACK_SESSION_ID);
  assert.equal(out["x-opencode-client"], "cli");
});
