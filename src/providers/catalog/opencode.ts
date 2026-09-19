import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import {
  ensureOpenCodeFreeTierBody,
  forceOpenCodeFreeTierStream,
  guardOpenCodeChatStreamEvent,
  guardOpenCodeInjectedToolCalls,
  guardOpenCodeResponsesStreamEvent,
  isOpencodeAnonymousKey,
  isOpencodeFreeTierModel,
  OPENCODE_USER_AGENT_RESPONSES,
  opencodeToolPlanFrom,
  rememberOpencodeToolPlan,
  stampOpenCodeSessionHeader,
  withOpenCodeAttribution,
  type OpencodeToolPlan,
} from "../opencode";
import type {
  AnyRequestTransform,
  AnyResponseTransform,
  AnyStreamTransform,
  TransformCtx,
} from "../../formats/pipeline";
import { onRequest, onResponse, onStreamEvent } from "../../formats/pipeline";
import type { Provider } from "../../types";

// OpenCode Zen - OpenAI-compatible gateway aimed at coding agents.
// Every completion request carries the CLI-shaped OpenCode attribution. Free
// anonymous attempts also stream upstream, matching the CLI's request body.
class OpenCodeAdapter extends OpenAICompatibleAdapter {
  // Stamp identity and apply the free-tier streaming requirement before any
  // format conversion. The converters can drop conversation fields, so the
  // session must be derived from the client-shaped body. The final
  // canonicalizer fills a shape-valid static fallback when needed.
  override requestTransforms(_provider: Provider): AnyRequestTransform[] {
    return [
      onRequest("chat", "opencode:session", (body, ctx) => {
        const typedBody = body as unknown as Record<string, unknown>;
        stampOpenCodeSessionHeader(typedBody, ctx.headers);
        forceOpenCodeFreeTierStream(typedBody, ctx.apiKey);
        const plan = applyFreeTierBody(typedBody, ctx, "chat");
        if (plan) rememberOpencodeToolPlan(ctx.state, plan);
        return body;
      }),
      onRequest("messages", "opencode:session", (body, ctx) => {
        stampOpenCodeSessionHeader(
          body as unknown as Record<string, unknown>,
          ctx.headers,
        );
        return body;
      }),
      onRequest("responses", "opencode:session", (body, ctx) => {
        const typedBody = body as unknown as Record<string, unknown>;
        stampOpenCodeSessionHeader(typedBody, ctx.headers);
        forceOpenCodeFreeTierStream(typedBody, ctx.apiKey);
        const plan = applyFreeTierBody(typedBody, ctx, "responses");
        if (plan) rememberOpencodeToolPlan(ctx.state, plan);
        return body;
      }),
    ];
  }

  // Enforce the invariant the injected tools exist to satisfy: a client must
  // never receive a call for a tool it never declared. Tagged by SHAPE, so the
  // stage lands pre-bridge (chat-shaped body) for a messages or responses
  // client and post-bridge for a converted one - either way it edits the api
  // shape the provider actually produced, before the client sees it.
  override responseTransforms(_provider: Provider): AnyResponseTransform[] {
    return [
      onResponse("chat", "opencode:tool-guard", (body, ctx) => {
        const plan = opencodeToolPlanFrom(ctx.state);
        if (plan)
          guardOpenCodeInjectedToolCalls(
            body as unknown as Record<string, unknown>,
            "chat",
            plan,
          );
        return body;
      }),
      onResponse("responses", "opencode:tool-guard", (body, ctx) => {
        const plan = opencodeToolPlanFrom(ctx.state);
        if (plan)
          guardOpenCodeInjectedToolCalls(
            body as unknown as Record<string, unknown>,
            "responses",
            plan,
          );
        return body;
      }),
    ];
  }

  override streamTransforms(_provider: Provider): AnyStreamTransform[] {
    return [
      onStreamEvent("chat", "opencode:tool-guard", (event, ctx) => {
        const plan = opencodeToolPlanFrom(ctx.state);
        if (!plan) return event;
        return guardOpenCodeChatStreamEvent(
          event as unknown as Record<string, unknown>,
          plan,
          ctx.state,
        ) as typeof event | null;
      }),
      onStreamEvent("responses", "opencode:tool-guard", (event, ctx) => {
        const plan = opencodeToolPlanFrom(ctx.state);
        if (!plan) return event;
        return guardOpenCodeResponsesStreamEvent(
          event as unknown as Record<string, unknown>,
          plan,
          ctx.state,
        ) as typeof event | null;
      }),
    ];
  }

  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    return super.chatCompletions({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body, {
        anonymousAuth: isOpencodeAnonymousKey(ctx.apiKey),
      }),
    });
  }

  override responses(ctx: BuildCtx): BuiltRequest {
    return super.responses({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body, {
        userAgent: OPENCODE_USER_AGENT_RESPONSES,
        anonymousAuth: isOpencodeAnonymousKey(ctx.apiKey),
      }),
    });
  }
}

// The rest of the free-tier body contract (`stream: true`, the CLI's core tools
// merged into `tools`, and usage on the stream), applied only to a FREE-TIER
// model reached anonymously: a real Zen-credit key keeps the caller's body
// verbatim even for a `-free` model, and an unknown/paid id is never rewritten.
// Runs on whatever body is in THIS stage's format (pre-conversion for the
// client's format, post-conversion for the provider's), because that is the
// body Zen gates on; the converter may drop a caller's tools, so the stage for
// the format actually on the wire is the one that guarantees they are present.
function applyFreeTierBody(
  body: Record<string, unknown>,
  ctx: TransformCtx,
  kind: "chat" | "responses",
): OpencodeToolPlan | null {
  if (typeof body !== "object" || body === null) return null;
  if (!isOpencodeAnonymousKey(ctx.apiKey)) return null;
  const model =
    ctx.upstreamModel ?? (typeof body.model === "string" ? body.model : "");
  if (!isOpencodeFreeTierModel(model)) return null;
  return ensureOpenCodeFreeTierBody(body, kind);
}

export const opencode = new OpenCodeAdapter({
  id: "opencode",
  label: "OpenCode Zen",
  blurb: "Coding-focused model gateway - OpenAI-compatible chat endpoint.",
  brand: "opencode",
  docsUrl: "https://opencode.ai/docs/zen/",
  defaults: {
    baseUrl: "https://opencode.ai/zen",
    endpoints: [WireKind.Chat, WireKind.Responses],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "opencode", required: true },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Point at your OpenCode instance if self-hosting.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
