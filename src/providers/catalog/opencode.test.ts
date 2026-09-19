// OpenCode Zen adapter tests: canonical attribution headers on the Chat and
// Responses builds, with a fake transport-free BuildCtx (no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { opencode } from "./opencode";
import {
  OPENCODE_ANONYMOUS_KEY,
  OPENCODE_FREE_TIER_TOOL_DEFINITIONS,
  OPENCODE_PLACEHOLDER_TOOLS_ENV,
  OPENCODE_USER_AGENT_RESPONSES,
  OPENCODE_USER_AGENT,
  OPENCODE_FALLBACK_SESSION_ID,
  OPENCODE_CLIENT,
  ensureOpenCodeFreeTierBody,
  guardOpenCodeChatStreamEvent,
  guardOpenCodeInjectedToolCalls,
  guardOpenCodeResponsesStreamEvent,
  isOpencodeFreeTierModel,
  isOpencodeFreeTierRefusal,
  openCodeFreeTierPlaceholderTools,
  openCodeSessionFromBody,
  opencodeToolPlanFrom,
  satisfiesOpencodeUserAgentContract,
  withOpenCodeAttribution,
  type FreeTierBodyKind,
  type OpencodeToolPlan,
} from "../opencode";
import type {
  TaggedRequestTransform,
  TransformCtx,
} from "../../formats/pipeline";
import { messagesRequestToChat } from "../../formats/converters/chat-messages/request";
import type { Provider } from "../../types";
import { WireKind } from "../../types";
import type { BuildCtx } from "../base";

// Gateway-derived ids use the exact OpenCode CLI shape: a `ses_`/`msg_`
// prefix, 12 lowercase hex characters, and 14 base62 characters.
const OPENCODE_ID_RE = /^(ses_|msg_)[0-9a-f]{12}[0-9A-Za-z]{14}$/;

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
  assert.match(built.headers["x-opencode-session"], OPENCODE_ID_RE);
  assert.ok(built.headers["x-opencode-session"]);
  // Deterministic per-conversation request id, same shape as the session
  // (stability across rebuilds is asserted in the buildFor seam test).
  assert.match(built.headers["x-opencode-request"], OPENCODE_ID_RE);
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

test("conflicting case variants are canonicalized and invalid caller ids are re-derived", () => {
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
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(ctx.body),
  );
  assert.match(built.headers["x-opencode-session"], OPENCODE_ID_RE);
  assert.match(built.headers["x-opencode-request"], OPENCODE_ID_RE);
  assert.equal(built.headers["x-opencode-client"], "cli");
  assert.equal(built.headers["x-opencode-project"], "global");
  assert.equal(built.headers["x-custom"], "keep-me");
});

test("missing identity falls back to the stable gateway session, never empty", () => {
  const body = { model: "m" };
  const built = opencode.chatCompletions(buildCtx({ body: { ...body } }));
  assert.equal(
    built.headers["x-opencode-session"],
    OPENCODE_FALLBACK_SESSION_ID,
  );
  assert.match(built.headers["x-opencode-session"], OPENCODE_ID_RE);
  assert.ok(built.headers["x-opencode-session"]);
  assert.match(built.headers["x-opencode-request"], OPENCODE_ID_RE);
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
  assert.equal(
    built.headers["x-opencode-session"],
    openCodeSessionFromBody(body),
  );
  assert.match(built.headers["x-opencode-session"], OPENCODE_ID_RE);
  assert.match(built.headers["x-opencode-request"], OPENCODE_ID_RE);
  assert.equal(built.headers["user-agent"], OPENCODE_USER_AGENT_RESPONSES);
  assert.equal(built.headers["x-opencode-project"], "global");
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
    ["opencode:session", "opencode:session", "opencode:session"],
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

test("invalid caller session is re-derived in the CLI shape", () => {
  const out = stampAndBuild(
    { model: "m", user: "someone-else" },
    { authorization: "Bearer zen-key", "X-OpenCode-Session": "caller-session" },
  );
  assert.equal(
    out["x-opencode-session"],
    openCodeSessionFromBody({ model: "m", user: "someone-else" }),
  );
  assert.match(out["x-opencode-session"], OPENCODE_ID_RE);
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
  assert.match(out["x-opencode-session"], OPENCODE_ID_RE);
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
  assert.match(out["x-opencode-session"], OPENCODE_ID_RE);
});

test("responses-client user field derives a session", () => {
  const body: Record<string, unknown> = { model: "m", user: "resp-user" };
  const out = stampAndBuild(body, {}, WireKind.Responses);
  assert.equal(
    out["x-opencode-session"],
    openCodeSessionFromBody({ user: "resp-user" }),
  );
  assert.match(out["x-opencode-session"], OPENCODE_ID_RE);
});

test("derived sessions are deterministic and identity-separating", () => {
  const a1 = openCodeSessionFromBody({ user: "a" });
  const a2 = openCodeSessionFromBody({ user: "a" });
  const b = openCodeSessionFromBody({ user: "b" });
  assert.ok(a1 && a2 && b);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, OPENCODE_ID_RE);
  assert.match(b, OPENCODE_ID_RE);
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

// --- free-tier body contract (anonymous caller, free-tier models only) -----

const FREE_MODEL = "mimo-v2.5-free";
const PAID_MODEL = "gpt-5.6-luna";

// Run the `opencode:session` stage tagged for `clientFmt` on a copy of the body
// and return what it produced, mirroring a real hop (buildTransformPlan runs
// exactly one stage by tag, pre-conversion).
function runStage(
  body: Record<string, unknown>,
  clientFmt: WireKind,
  ctx: Partial<TransformCtx> = {},
): Record<string, unknown> {
  const stages = opencode.requestTransforms(STAMP_PROVIDER);
  const stage = (stages as TaggedRequestTransform[]).find(
    (s) => s.format === clientFmt,
  );
  assert.ok(stage, `no opencode:session stage tagged ${clientFmt}`);
  return stage.apply({ ...body }, {
    ...transformCtx({}, clientFmt),
    ...ctx,
  }) as Record<string, unknown>;
}

function chatToolNames(body: Record<string, unknown>): string[] {
  return (body.tools as { function: { name: string } }[]).map(
    (t) => t.function.name,
  );
}

type CliToolDefinition = {
  description: string;
  parameters: Record<string, unknown>;
};

// The exported CLI definition for one name - the single source of truth the
// module injects from, so the tests never restate the captured text.
function cliToolDefinition(name: string): CliToolDefinition {
  const definition = OPENCODE_FREE_TIER_TOOL_DEFINITIONS[name] as
    | CliToolDefinition
    | undefined;
  assert.ok(definition, `no exported CLI tool definition for ${name}`);
  return definition;
}

// Assert one injected entry carries that definition verbatim. `fn` is the
// definition-carrying object: the nested `function` object on Chat, the tool
// entry itself on Responses.
function assertInjectedCliDefinition(fn: Record<string, unknown>): void {
  const definition = cliToolDefinition(fn.name as string);
  assert.deepEqual(fn.description, definition.description);
  assert.deepEqual(fn.parameters, definition.parameters);
}

test("anonymous free-tier chat body gains stream + the CLI's required tools", () => {
  const out = runStage({ model: FREE_MODEL }, WireKind.Chat, {
    apiKey: "public",
    upstreamModel: FREE_MODEL,
  });
  assert.equal(out.stream, true);
  // `bash` and `read` are the names the live gate requires; glob/grep ride
  // along as the CLI's other read-only tools.
  assert.deepEqual(chatToolNames(out), ["bash", "glob", "grep", "read"]);
  for (const tool of out.tools as Record<string, unknown>[]) {
    assert.equal(tool.type, "function");
    assertInjectedCliDefinition(tool.function as Record<string, unknown>);
  }
  // The old "do not call this" stand-in is gone from the wire body entirely.
  assert.ok(!JSON.stringify(out).includes("must never be invoked"));
  // Spot-check one entry against the CLI's captured schema: `bash` carries the
  // `command` property and requires it.
  const bashSchema = cliToolDefinition("bash").parameters as {
    properties?: Record<string, unknown>;
    required?: unknown[];
  };
  assert.ok(
    bashSchema.properties !== undefined && "command" in bashSchema.properties,
    "bash must carry the CLI's own `command` property",
  );
  assert.ok(
    Array.isArray(bashSchema.required) && bashSchema.required.includes("command"),
    "bash must require `command`",
  );
  // The CLI asks for usage on the stream it forces.
  assert.deepEqual(out.stream_options, { include_usage: true });
  // Our placeholders are gate-satisfying artifacts, not tools the caller can
  // answer, so an entirely-injected list pins tool_choice to "none" (the
  // Responses endpoint 400s on "none", which is why this is Chat-only - see
  // the responses test below).
  assert.equal(out.tool_choice, "none");
});

test("a null key (no key configured) is the same anonymous caller", () => {
  const out = runStage({ model: FREE_MODEL }, WireKind.Chat, {
    apiKey: null,
    upstreamModel: FREE_MODEL,
  });
  assert.equal(out.stream, true);
  assert.deepEqual(chatToolNames(out), ["bash", "glob", "grep", "read"]);
});

test("caller tools are kept verbatim and only the missing names are merged in", () => {
  const tools = [
    { type: "function", function: { name: "read_file", parameters: {} } },
    { type: "function", function: { name: "bash", parameters: { marker: 1 } } },
  ];
  const out = runStage({ model: "big-pickle", tools }, WireKind.Chat, {
    apiKey: "public",
    upstreamModel: "big-pickle",
  });
  assert.equal(out.stream, true);
  // The caller's own entries survive untouched (including its `bash`
  // definition, which is never replaced) and the absent names are appended.
  const merged = out.tools as Record<string, unknown>[];
  assert.deepEqual(merged.slice(0, 2), tools);
  assert.deepEqual(chatToolNames(out), [
    "read_file",
    "bash",
    "glob",
    "grep",
    "read",
  ]);
  // The appended entries are the CLI's real definitions (the caller's own
  // entries above stay untouched).
  for (const tool of merged.slice(2)) {
    assertInjectedCliDefinition(tool.function as Record<string, unknown>);
  }
  // An empty array is refused upstream exactly like a missing one.
  const empty = runStage({ model: FREE_MODEL, tools: [] }, WireKind.Chat, {
    apiKey: "public",
    upstreamModel: FREE_MODEL,
  });
  assert.deepEqual(chatToolNames(empty), ["bash", "glob", "grep", "read"]);
  // A caller that brought its own tools keeps its own tool_choice (never
  // pinned to "none").
  const callerChoice = runStage(
    { model: FREE_MODEL, tools, tool_choice: "auto" },
    WireKind.Chat,
    { apiKey: "public", upstreamModel: FREE_MODEL },
  );
  assert.equal(callerChoice.tool_choice, "auto");
  // A caller-supplied stream_options is preserved, not clobbered.
  const withOptions = runStage(
    { model: FREE_MODEL, stream_options: { include_usage: false, extra: 1 } },
    WireKind.Chat,
    { apiKey: "public", upstreamModel: FREE_MODEL },
  );
  assert.deepEqual(withOptions.stream_options, {
    include_usage: true,
    extra: 1,
  });
});

test("anonymous free-tier responses body gains flat placeholder tools", () => {
  const out = runStage({ model: "muse-spark-1.3-contributor-free" }, WireKind.Responses, {
    apiKey: "public",
    upstreamModel: "muse-spark-1.3-contributor-free",
  });
  assert.equal(out.stream, true);
  const tools = out.tools as Record<string, unknown>[];
  assert.deepEqual(
    tools.map((t) => t.name),
    ["bash", "glob", "grep", "read"],
  );
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    // Responses puts the definition flat on the entry, not under `function`.
    assert.equal("function" in tool, false);
    assertInjectedCliDefinition(tool);
  }
  // The old stand-in text never reaches the responses wire body either.
  assert.ok(!JSON.stringify(out).includes("must never be invoked"));
  // stream_options and tool_choice:"none" are Chat-only: never invented here
  // (the Responses endpoint rejects tool_choice "none" with a 400).
  assert.equal("stream_options" in out, false);
  assert.equal("tool_choice" in out, false);
});

test("a paid model or a real key is left verbatim", () => {
  // Paid model with a real key: neither the stream forcing nor the tools.
  const paid = runStage({ model: PAID_MODEL }, WireKind.Chat, {
    apiKey: "zen-key",
    upstreamModel: PAID_MODEL,
  });
  assert.equal("stream" in paid, false);
  assert.equal("tools" in paid, false);

  // Anonymous paid model: the pre-existing stream forcing still applies (the
  // free tier refuses a buffered request), but no placeholder tools are added -
  // only the free-tier roster needs them.
  const anonPaid = runStage({ model: PAID_MODEL }, WireKind.Chat, {
    apiKey: "public",
    upstreamModel: PAID_MODEL,
  });
  assert.equal(anonPaid.stream, true);
  assert.equal("tools" in anonPaid, false);

  // Free model with a real Zen-credit key: the caller's body is theirs.
  const keyed = runStage({ model: FREE_MODEL }, WireKind.Chat, {
    apiKey: "zen-key",
    upstreamModel: FREE_MODEL,
  });
  assert.equal("stream" in keyed, false);
  assert.equal("tools" in keyed, false);
});

test("free-tier model detection covers the suffix and the unsuffixed roster", () => {
  assert.equal(isOpencodeFreeTierModel("mimo-v2.5-free"), true);
  assert.equal(isOpencodeFreeTierModel("muse-spark-1.3-contributor-free"), true);
  assert.equal(isOpencodeFreeTierModel("big-pickle"), true);
  assert.equal(isOpencodeFreeTierModel("gpt-5.6-luna"), false);
  assert.equal(isOpencodeFreeTierModel(""), false);
});

test("placeholder names are operator-overridable, invalid entries dropped", () => {
  assert.deepEqual(openCodeFreeTierPlaceholderTools({}), [
    "bash",
    "glob",
    "grep",
    "read",
  ]);
  assert.deepEqual(
    openCodeFreeTierPlaceholderTools({
      [OPENCODE_PLACEHOLDER_TOOLS_ENV]: "read, 9bad, bash",
    }),
    ["read", "bash"],
  );
  // An override can never drop the names the gate requires by name.
  assert.deepEqual(
    openCodeFreeTierPlaceholderTools({
      [OPENCODE_PLACEHOLDER_TOOLS_ENV]: "custom_tool",
    }),
    ["bash", "read", "custom_tool"],
  );
  // An all-invalid override must never yield a tool-less (refused) body.
  assert.deepEqual(
    openCodeFreeTierPlaceholderTools({
      [OPENCODE_PLACEHOLDER_TOOLS_ENV]: "  9bad, ",
    }),
    ["bash", "glob", "grep", "read"],
  );

  // ...and the body builder reads the override off the environment.
  const previous = process.env[OPENCODE_PLACEHOLDER_TOOLS_ENV];
  process.env[OPENCODE_PLACEHOLDER_TOOLS_ENV] = "bash,glob";
  try {
    const body: Record<string, unknown> = { model: FREE_MODEL };
    ensureOpenCodeFreeTierBody(body, "chat");
    // The required pair is prepended to the override, never replaced by it.
    assert.deepEqual(chatToolNames(body), ["read", "bash", "glob"]);
    // A configured CLI name still resolves to its CLI definition in a mixed
    // list (here the `bash` entry, second in the injected order).
    assertInjectedCliDefinition(
      (body.tools as Record<string, unknown>[])[1].function as Record<
        string,
        unknown
      >,
    );

    // A name the operator invents is not a CLI tool: it gets the neutral
    // fallback description and the empty schema, never a CLI definition.
    process.env[OPENCODE_PLACEHOLDER_TOOLS_ENV] = "custom_tool";
    const custom: Record<string, unknown> = { model: FREE_MODEL };
    ensureOpenCodeFreeTierBody(custom, "chat");
    assert.deepEqual(chatToolNames(custom), ["bash", "read", "custom_tool"]);
    const injected = (custom.tools as Record<string, unknown>[]).find(
      (tool) =>
        (tool.function as Record<string, unknown>).name === "custom_tool",
    );
    assert.ok(injected, "the operator's custom name must still be injected");
    const fn = injected.function as Record<string, unknown>;
    assert.equal(
      typeof fn.description,
      "string",
      "the fallback description must be a string",
    );
    const fallbackDescription = fn.description as string;
    assert.ok(
      fallbackDescription.length > 0,
      "the fallback description must be non-empty",
    );
    assert.ok(
      !Object.values(OPENCODE_FREE_TIER_TOOL_DEFINITIONS).some(
        (definition) => definition.description === fallbackDescription,
      ),
      "a name outside the CLI table must not borrow a CLI tool description",
    );
    assert.deepEqual(fn.parameters, { type: "object", properties: {} });
  } finally {
    if (previous === undefined) delete process.env[OPENCODE_PLACEHOLDER_TOOLS_ENV];
    else process.env[OPENCODE_PLACEHOLDER_TOOLS_ENV] = previous;
  }
});

// --- CLI user-agent contract + anonymous identity --------------------------

test("the CLI UA contract needs a current opencode release", () => {
  assert.equal(satisfiesOpencodeUserAgentContract("opencode/1.18.31 x"), true);
  assert.equal(satisfiesOpencodeUserAgentContract(`opencode/1.17.0`), true);
  assert.equal(satisfiesOpencodeUserAgentContract("opencode/2.0.1"), true);
  assert.equal(satisfiesOpencodeUserAgentContract("opencode/1.16.9"), false);
  assert.equal(satisfiesOpencodeUserAgentContract("curl/8.5.0"), false);
  assert.equal(satisfiesOpencodeUserAgentContract(""), false);
  assert.equal(satisfiesOpencodeUserAgentContract(null), false);
  assert.equal(satisfiesOpencodeUserAgentContract(undefined), false);
});

test("a stale caller UA is replaced, a contractual one is preserved", () => {
  const stale = withOpenCodeAttribution(
    { "User-Agent": "curl/8.5.0", authorization: "Bearer zen-key" },
    { model: "m" },
  );
  assert.deepEqual(
    Object.keys(stale).filter((k) => k.toLowerCase() === "user-agent"),
    ["user-agent"],
  );
  assert.equal(stale["user-agent"], OPENCODE_USER_AGENT);
  assert.equal(stale.authorization, "Bearer zen-key");

  const old = withOpenCodeAttribution(
    { "user-agent": "opencode/1.16.9 ai-sdk/provider-utils/4.0.23" },
    { model: "m" },
  );
  assert.equal(old["user-agent"], OPENCODE_USER_AGENT);

  const kept = withOpenCodeAttribution(
    { "UPPER-CASE": "x", "User-Agent": "opencode/1.17.12 cli" },
    { model: "m" },
  );
  assert.equal(kept["User-Agent"], "opencode/1.17.12 cli");
  assert.equal(
    Object.keys(kept).filter((k) => k.toLowerCase() === "user-agent").length,
    1,
  );
});

test("anonymous build claims the free-tier identity; a real key is untouched", () => {
  const anon = opencode.chatCompletions(
    buildCtx({ apiKey: null, body: { model: FREE_MODEL } }),
  );
  assert.equal(anon.headers.authorization, `Bearer ${OPENCODE_ANONYMOUS_KEY}`);

  // The engine forwards the CLIENT's own gateway bearer when no key is
  // configured - that must be overwritten, not preserved.
  const leaked = opencode.chatCompletions(
    buildCtx({
      apiKey: "public",
      body: { model: FREE_MODEL },
      headers: {
        authorization: "Bearer client-gateway-bearer",
        "content-type": "application/json",
        "x-custom": "keep-me",
      },
    }),
  );
  assert.equal(leaked.headers.authorization, `Bearer ${OPENCODE_ANONYMOUS_KEY}`);
  assert.equal(leaked.headers["x-custom"], "keep-me");

  const real = opencode.chatCompletions(buildCtx({ apiKey: "zen-key" }));
  assert.equal(real.headers.authorization, "Bearer zen-key");
});

// --- refusal accounting ----------------------------------------------------

test("a 403 FreeTierError is a refusal of the request, not of the key", () => {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "FreeTierError",
      message:
        "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
    },
  });
  assert.equal(isOpencodeFreeTierRefusal(403, body), true);
  assert.equal(isOpencodeFreeTierRefusal(451, body), true);
  assert.equal(
    isOpencodeFreeTierRefusal(
      403,
      '{"error":{"type":"FreeTierError","message":"nope"}}',
    ),
    true,
  );

  // Ordinary auth failures and unrelated statuses stay auth failures.
  assert.equal(isOpencodeFreeTierRefusal(401, body), false);
  assert.equal(
    isOpencodeFreeTierRefusal(403, '{"error":{"message":"invalid api key"}}'),
    false,
  );
  assert.equal(isOpencodeFreeTierRefusal(403, null), false);
  assert.equal(isOpencodeFreeTierRefusal(403, ""), false);
  assert.equal(isOpencodeFreeTierRefusal(500, body), false);
});

// --- injected-tool aliases + the response guard -----------------------------
//
// The gate matches tool NAMES only, so a client that declares its own tools
// (Claude Code's `Bash`/`Read`, an agent's `shell`, ...) gets entries injected
// under lowercase names it never declared - and models call them. These tests
// pin both halves of the answer: an injected entry ALIASES the client's own
// tool when exactly one of them matches (so the model is handed the argument
// names the client can actually parse), and the response guard renames an
// aliased call back to the client's own spelling or drops a call to a name the
// client has no counterpart for.

// A client tool in the Chat shape: the definition nested under `function`.
function clientTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

// Claude Code's own tools. `Read` takes `file_path`, where the CLI's captured
// `read` definition takes `filePath`: the two schemas differ on purpose, so the
// tests can tell an alias (the client's schema) from a placeholder (the CLI's).
const CLIENT_READ = clientTool(
  "Read",
  "Reads a file from the local filesystem.",
  { file_path: { type: "string", description: "The absolute path to the file" } },
  ["file_path"],
);
const CLIENT_BASH = clientTool(
  "Bash",
  "Runs a shell command in a persistent session.",
  { command: { type: "string" } },
  ["command"],
);
const CLIENT_TOOLS = [CLIENT_BASH, CLIENT_READ];

function clientFunction(tool: Record<string, unknown>): Record<string, unknown> {
  return tool.function as Record<string, unknown>;
}

// The injected Chat entry carrying `name`, as the definition object the shape
// nests it in.
function injectedFunction(
  body: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const tool = (body.tools as Record<string, unknown>[]).find((entry) => {
    const fn = entry.function as Record<string, unknown> | undefined;
    return fn?.name === name;
  });
  assert.ok(tool, `no injected chat tool named ${name}`);
  return tool.function as Record<string, unknown>;
}

// The plan the request half records for `tools`, derived from the real builder
// instead of hand-copied, so a guard test cannot drift from what the stage
// actually injects.
function toolPlan(
  tools: unknown[],
  kind: FreeTierBodyKind = "chat",
): OpencodeToolPlan {
  return ensureOpenCodeFreeTierBody({ model: FREE_MODEL, tools }, kind);
}

function chatCall(id: string, name: string, args = "{}"): Record<string, unknown> {
  return { id, type: "function", function: { name, arguments: args } };
}

// A one-turn chat response body carrying `calls`.
function chatTurn(calls: Record<string, unknown>[]): Record<string, unknown> {
  return {
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: calls },
      },
    ],
  };
}

function firstChoice(body: Record<string, unknown>): Record<string, unknown> {
  return (body.choices as Record<string, unknown>[])[0];
}

// One streamed chat delta carrying a single tool-call fragment at `index`.
function chatStreamDelta(
  fragment: Record<string, unknown>,
  index = 0,
): Record<string, unknown> {
  return {
    choices: [{ index: 0, delta: { tool_calls: [{ index, ...fragment }] } }],
  };
}

function streamedFunction(event: Record<string, unknown>): Record<string, unknown> {
  const delta = firstChoice(event).delta as Record<string, unknown>;
  return (delta.tool_calls as Record<string, unknown>[])[0].function as Record<
    string,
    unknown
  >;
}

test("an injected name aliases the client's own tool instead of the CLI's", () => {
  const body: Record<string, unknown> = { model: FREE_MODEL, tools: CLIENT_TOOLS };
  const plan = ensureOpenCodeFreeTierBody(body, "chat");

  // The caller's entries survive untouched and the gate names are appended.
  assert.deepEqual(chatToolNames(body), [
    "Bash",
    "Read",
    "bash",
    "glob",
    "grep",
    "read",
  ]);

  // `read` stands in for the caller's `Read`, so it carries the CLIENT's
  // description and parameter schema - a call the model makes against it is
  // already valid for the tool the client will actually run.
  const read = injectedFunction(body, "read");
  assert.deepEqual(read.description, clientFunction(CLIENT_READ).description);
  assert.deepEqual(read.parameters, clientFunction(CLIENT_READ).parameters);
  const bash = injectedFunction(body, "bash");
  assert.deepEqual(bash.description, clientFunction(CLIENT_BASH).description);
  assert.deepEqual(bash.parameters, clientFunction(CLIENT_BASH).parameters);

  // The plan names the client tool each injected name stands in for, which is
  // what lets the response side rename a call back.
  assert.deepEqual(plan.injected, ["bash", "glob", "grep", "read"]);
  assert.deepEqual(plan.aliases, { bash: "Bash", read: "Read" });
  assert.deepEqual(plan.foreign, { glob: true, grep: true });
});

test("an injected name with no client counterpart keeps the CLI's captured definition", () => {
  const body: Record<string, unknown> = { model: FREE_MODEL, tools: [CLIENT_READ] };
  const plan = ensureOpenCodeFreeTierBody(body, "chat");

  // `read` is an alias; the three names this client never declared are not, so
  // the model is handed the CLI's own definitions for them - and a call to one
  // has no client tool to be delivered as.
  assert.deepEqual(plan.aliases, { read: "Read" });
  assert.deepEqual(plan.foreign, { bash: true, glob: true, grep: true });
  for (const name of ["bash", "glob", "grep"]) {
    assertInjectedCliDefinition(injectedFunction(body, name));
  }
});

test("two case-insensitively equal client tools leave the alias ambiguous, never guessed", () => {
  const shouty = clientTool(
    "READ",
    "Another read tool.",
    { path: { type: "string" } },
    ["path"],
  );
  const body: Record<string, unknown> = {
    model: FREE_MODEL,
    tools: [CLIENT_READ, shouty],
  };
  const plan = ensureOpenCodeFreeTierBody(body, "chat");

  // Renaming a call into either one would hand the client a tool it may not
  // route, so the CLI's own definition is forwarded and the call is dropped.
  assert.deepEqual(plan.aliases, {});
  assert.deepEqual(plan.foreign, {
    bash: true,
    glob: true,
    grep: true,
    read: true,
  });
  assertInjectedCliDefinition(injectedFunction(body, "read"));
  // Neither of the caller's own entries is touched.
  assert.deepEqual((body.tools as unknown[]).slice(0, 2), [CLIENT_READ, shouty]);
});

test("the chat request stage records the injected-tool plan for the response side", () => {
  // The response/stream guards read the plan off the attempt's state bag, which
  // only the request stage (pre-conversion, on the client-shaped body) fills.
  const state: Record<string, unknown> = {};
  const out = runStage({ model: FREE_MODEL, tools: CLIENT_TOOLS }, WireKind.Chat, {
    apiKey: "public",
    upstreamModel: FREE_MODEL,
    state,
  });

  const plan = opencodeToolPlanFrom(state);
  assert.ok(plan, "the stage must hand the response side what it injected");
  assert.deepEqual(plan, {
    injected: ["bash", "glob", "grep", "read"],
    aliases: { bash: "Bash", read: "Read" },
    foreign: { glob: true, grep: true },
  });
  // ...and the recorded plan describes the body the stage actually produced.
  assert.deepEqual(chatToolNames(out), [
    "Bash",
    "Read",
    "bash",
    "glob",
    "grep",
    "read",
  ]);
});

test("the buffered chat guard renames an aliased call and drops a foreign one", () => {
  const plan = toolPlan(CLIENT_TOOLS);
  const body = chatTurn([
    chatCall("a", "read", '{"file_path":"/tmp/x"}'),
    chatCall("b", "Bash", '{"command":"ls"}'),
    chatCall("c", "glob", '{"pattern":"*"}'),
  ]);

  guardOpenCodeInjectedToolCalls(body, "chat", plan);

  const calls = (firstChoice(body).message as Record<string, unknown>)
    .tool_calls as Record<string, unknown>[];
  // `read` becomes the client's `Read`; the client's own `Bash` is never
  // touched (it is not a name we injected); the foreign `glob` is gone. The
  // arguments are untouched because the alias carried the client's schema.
  assert.deepEqual(
    calls.map((call) => (call.function as Record<string, unknown>).name),
    ["Read", "Bash"],
  );
  assert.deepEqual(calls.map((call) => call.id), ["a", "b"]);
  assert.equal(
    (calls[0].function as Record<string, unknown>).arguments,
    '{"file_path":"/tmp/x"}',
  );
  // A call survived, so the turn is still a tool_calls turn.
  assert.equal(firstChoice(body).finish_reason, "tool_calls");
});

test("a chat turn whose calls were all foreign loses tool_calls and ends as stop", () => {
  const plan = toolPlan(CLIENT_TOOLS);
  const body = chatTurn([chatCall("a", "glob"), chatCall("b", "grep")]);

  guardOpenCodeInjectedToolCalls(body, "chat", plan);

  const message = firstChoice(body).message as Record<string, unknown>;
  // Nothing the client can answer: the key goes away entirely rather than
  // leaving an empty array, and the turn is downgraded so the client does not
  // wait for a tool result that will never come.
  assert.equal("tool_calls" in message, false);
  assert.equal(firstChoice(body).finish_reason, "stop");
});

test("a chat response calling only names the client knows is left byte-identical", () => {
  const plan = toolPlan(CLIENT_TOOLS);
  const body = chatTurn([
    chatCall("a", "Bash", '{"command":"ls"}'),
    chatCall("b", "Write"),
  ]);

  const before = JSON.stringify(body);
  guardOpenCodeInjectedToolCalls(body, "chat", plan);

  // `Write` is neither injected nor aliased: a legitimate call is never
  // rewritten on the strength of a name we injected.
  assert.equal(JSON.stringify(body), before);
});

test("the buffered responses guard renames an aliased function_call and drops a foreign one", () => {
  const plan = toolPlan(CLIENT_TOOLS, "responses");
  const body: Record<string, unknown> = {
    output: [
      { type: "message", role: "assistant", content: [] },
      {
        type: "function_call",
        call_id: "c1",
        name: "read",
        arguments: '{"file_path":"/tmp/x"}',
      },
      { type: "function_call", call_id: "c2", name: "grep", arguments: "{}" },
    ],
  };

  guardOpenCodeInjectedToolCalls(body, "responses", plan);

  const output = body.output as Record<string, unknown>[];
  // Only the foreign call is removed: the unrelated output item and the
  // renamed call keep their order and their arguments.
  assert.deepEqual(
    output.map((item) => item.type),
    ["message", "function_call"],
  );
  assert.equal(output[1].name, "Read");
  assert.equal(output[1].call_id, "c1");
  assert.equal(output[1].arguments, '{"file_path":"/tmp/x"}');
});

test("a streamed aliased call is renamed as it is announced, its fragments pass through", () => {
  const plan = toolPlan(CLIENT_TOOLS);
  const state: Record<string, unknown> = {};

  // The name arrives alone, in the first delta for that call index.
  const announce = chatStreamDelta({ function: { name: "read", arguments: "" } });
  const returned = guardOpenCodeChatStreamEvent(announce, plan, state);
  assert.ok(returned, "an aliased call is deliverable");
  assert.equal(streamedFunction(announce).name, "Read");

  // The later fragments are the client's own schema's arguments, so they are
  // forwarded untouched - the rename is a name-only rewrite.
  const args = chatStreamDelta({
    function: { arguments: '{"file_path":"/tmp/x"}' },
  });
  const before = JSON.stringify(args);
  assert.equal(guardOpenCodeChatStreamEvent(args, plan, state), args);
  assert.equal(JSON.stringify(args), before);
});

test("a streamed foreign call is dropped with every fragment that follows its index", () => {
  const plan = toolPlan(CLIENT_TOOLS);
  const state: Record<string, unknown> = {};

  const announce = chatStreamDelta({ function: { name: "glob", arguments: "" } });
  assert.equal(guardOpenCodeChatStreamEvent(announce, plan, state), null);

  // The arguments dribble in their own chunks, so the decision has to be
  // remembered per call index: every later fragment for it disappears too.
  const args = chatStreamDelta({ function: { arguments: '{"pattern":"*"}' } });
  assert.equal(guardOpenCodeChatStreamEvent(args, plan, state), null);

  // A call at another index is untouched - including the client's own spelling
  // of a name we injected under a different case.
  const own = chatStreamDelta({ function: { name: "Read" } }, 1);
  assert.equal(guardOpenCodeChatStreamEvent(own, plan, state), own);
  assert.equal(streamedFunction(own).name, "Read");
});

test("a streamed tool_calls turn nobody can answer ends as an ordinary stop", () => {
  const plan = toolPlan(CLIENT_TOOLS);
  const state: Record<string, unknown> = {};

  // The turn's only call was ours and foreign, so it was dropped here.
  assert.equal(
    guardOpenCodeChatStreamEvent(
      chatStreamDelta({ function: { name: "grep" } }),
      plan,
      state,
    ),
    null,
  );

  const finish = {
    choices: [
      { index: 0, delta: { content: "done" }, finish_reason: "tool_calls" },
    ],
  };
  assert.ok(guardOpenCodeChatStreamEvent(finish, plan, state));
  // No call survived, so the client must not be told to wait for a tool result.
  assert.equal(firstChoice(finish).finish_reason, "stop");

  // A chunk that carried nothing but a dropped call's fate disappears entirely:
  // an emptied delta would otherwise still reach the client as a visible chunk.
  const emptied = {
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  assert.equal(guardOpenCodeChatStreamEvent(emptied, plan, state), null);
});

test("a streamed turn with a surviving call keeps its tool_calls finish reason", () => {
  const plan = toolPlan(CLIENT_TOOLS);
  const state: Record<string, unknown> = {};

  assert.ok(
    guardOpenCodeChatStreamEvent(
      chatStreamDelta({ function: { name: "read" } }),
      plan,
      state,
    ),
  );

  const finish = {
    choices: [
      { index: 0, delta: { content: "done" }, finish_reason: "tool_calls" },
    ],
  };
  const before = JSON.stringify(finish);
  assert.equal(guardOpenCodeChatStreamEvent(finish, plan, state), finish);
  assert.equal(firstChoice(finish).finish_reason, "tool_calls");
  assert.equal(JSON.stringify(finish), before);
});

test("the responses stream guard renames an aliased call and drops a foreign one", () => {
  const plan = toolPlan(CLIENT_TOOLS, "responses");
  const state: Record<string, unknown> = {};

  // A foreign call is dropped where it is announced, and its argument deltas -
  // matched by output index - follow it.
  const announced = {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", call_id: "c2", name: "grep" },
  };
  assert.equal(guardOpenCodeResponsesStreamEvent(announced, plan, state), null);
  assert.equal(
    guardOpenCodeResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "c2",
        delta: '{"pattern":"x"}',
      },
      plan,
      state,
    ),
    null,
  );

  // The aliased call is announced whole, so it is renamed on the spot.
  const aliased = {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "c1", name: "read" },
  };
  assert.equal(guardOpenCodeResponsesStreamEvent(aliased, plan, state), aliased);
  assert.equal((aliased.item as Record<string, unknown>).name, "Read");
  // Its argument deltas already fit the client's schema: forwarded untouched.
  const args = {
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: "c1",
    delta: '{"file_path":"/tmp/x"}',
  };
  assert.equal(guardOpenCodeResponsesStreamEvent(args, plan, state), args);
});

test("an empty plan is a pass-through on both sides", () => {
  // A caller that already declares every name the free tier injects - an
  // OpenCode-shaped client - gets nothing injected, so there is nothing to
  // rename or drop.
  const own = ["bash", "glob", "grep", "read"].map((name) =>
    clientTool(
      name,
      `The client's own ${name}.`,
      { arg: { type: "string" } },
      ["arg"],
    ),
  );
  const plan = toolPlan(own);
  assert.deepEqual(plan, { injected: [], aliases: {}, foreign: {} });

  const body = chatTurn([chatCall("a", "read"), chatCall("b", "bash")]);
  const before = JSON.stringify(body);
  guardOpenCodeInjectedToolCalls(body, "chat", plan);
  assert.equal(JSON.stringify(body), before);

  const state: Record<string, unknown> = {};
  const announce = chatStreamDelta({ function: { name: "read" } });
  assert.equal(guardOpenCodeChatStreamEvent(announce, plan, state), announce);
  assert.equal(streamedFunction(announce).name, "read");

  // With no plan recorded at all - the state the adapter reads - there is even
  // less to do.
  assert.equal(opencodeToolPlanFrom(undefined), null);
  assert.equal(opencodeToolPlanFrom({}), null);
});

test("a real key or a paid model records no plan to enforce", () => {
  // Free model on a real Zen-credit key: the caller's body is theirs, so
  // nothing was injected and the response side must not rewrite anything.
  const keyed: Record<string, unknown> = {};
  runStage({ model: FREE_MODEL, tools: CLIENT_TOOLS }, WireKind.Chat, {
    apiKey: "zen-key",
    upstreamModel: FREE_MODEL,
    state: keyed,
  });
  assert.equal(opencodeToolPlanFrom(keyed), null);

  // Anonymous paid model: the stream forcing still applies, but the free-tier
  // tool contract (and so the plan) does not.
  const paid: Record<string, unknown> = {};
  runStage({ model: PAID_MODEL, tools: CLIENT_TOOLS }, WireKind.Chat, {
    apiKey: "public",
    upstreamModel: PAID_MODEL,
    state: paid,
  });
  assert.equal(opencodeToolPlanFrom(paid), null);
});
