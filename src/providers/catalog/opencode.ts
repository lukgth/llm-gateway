import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import {
  forceOpenCodeFreeTierStream,
  OPENCODE_USER_AGENT_RESPONSES,
  stampOpenCodeSessionHeader,
  withOpenCodeAttribution,
} from "../opencode";
import type { AnyRequestTransform } from "../../formats/pipeline";
import { onRequest } from "../../formats/pipeline";
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
        return body;
      }),
    ];
  }

  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    return super.chatCompletions({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body),
    });
  }

  override responses(ctx: BuildCtx): BuiltRequest {
    return super.responses({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body, {
        userAgent: OPENCODE_USER_AGENT_RESPONSES,
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
