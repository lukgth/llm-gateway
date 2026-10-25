import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import {
  applyOpenCodeFreeTierContract,
  forceOpenCodeFreeTierStream,
  guardOpenCodeChatStreamEvent,
  guardOpenCodeInjectedToolCalls,
  guardOpenCodeResponsesStreamEvent,
  isOpencodeAnonymousKey,
  needsOpenCodeFreeTierRelay,
  OPENCODE_USER_AGENT_RESPONSES,
  opencodeToolPlanFrom,
  rememberOpencodeToolPlan,
  stampOpenCodeSessionHeader,
  withOpenCodeAttribution,
} from "../opencode";
import type {
  AnyRequestTransform,
  AnyResponseTransform,
  AnyStreamTransform,
} from "../../formats/pipeline";
import { onRequest, onResponse, onStreamEvent } from "../../formats/pipeline";
import type { Provider } from "../../types";

// OpenCode Zen - OpenAI-compatible gateway aimed at coding agents.
// Every completion request carries the CLI-shaped OpenCode attribution. Free
// anonymous attempts also stream upstream, matching the CLI's request body.
// The anonymous free tier meters its allowance per session id, so those
// requests mint a new one per attempt; everything else keeps the
// conversation-stable (cache-friendly) identity. Same predicate the engine uses
// to decide the Bun relay, so the two can never disagree.
function isFreeTierRelay(ctx: BuildCtx): boolean {
  return needsOpenCodeFreeTierRelay(
    ctx.provider.catalogId,
    ctx.apiKey,
    String(ctx.model ?? ""),
  );
}

class OpenCodeAdapter extends OpenAICompatibleAdapter {
  // Stamp identity before any format conversion: the converters can drop
  // conversation fields, so the session must be derived from the client-shaped
  // body. The free-tier BODY contract (stream forcing, the `read` tool, the
  // <env> block) is applied later, in the build phase, because it belongs on
  // the provider's wire body - see chatCompletions/responses below.
  override requestTransforms(_provider: Provider): AnyRequestTransform[] {
    return [
      onRequest("chat", "opencode:session", (body, ctx) => {
        stampOpenCodeSessionHeader(
          body as unknown as Record<string, unknown>,
          ctx.headers,
        );
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
        stampOpenCodeSessionHeader(
          body as unknown as Record<string, unknown>,
          ctx.headers,
        );
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

  // The free-tier body contract runs HERE, on the provider-shaped wire body:
  // it is the body Zen gates on, and it is the only place a converted client
  // (Messages -> Chat, Responses -> Chat) is covered. `stream` forcing rides
  // along with it for the same reason.
  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    forceOpenCodeFreeTierStream(ctx.body, ctx.apiKey);
    const plan = applyOpenCodeFreeTierContract(
      ctx.body,
      "chat",
      ctx.apiKey,
      ctx.model,
    );
    if (plan) rememberOpencodeToolPlan(ctx.state, plan);
    return super.chatCompletions({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body, {
        anonymousAuth: isOpencodeAnonymousKey(ctx.apiKey),
        freshIds: isFreeTierRelay(ctx),
      }),
    });
  }

  override responses(ctx: BuildCtx): BuiltRequest {
    forceOpenCodeFreeTierStream(ctx.body, ctx.apiKey);
    const plan = applyOpenCodeFreeTierContract(
      ctx.body,
      "responses",
      ctx.apiKey,
      ctx.model,
    );
    if (plan) rememberOpencodeToolPlan(ctx.state, plan);
    return super.responses({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body, {
        userAgent: OPENCODE_USER_AGENT_RESPONSES,
        anonymousAuth: isOpencodeAnonymousKey(ctx.apiKey),
        freshIds: isFreeTierRelay(ctx),
      }),
    });
  }
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
