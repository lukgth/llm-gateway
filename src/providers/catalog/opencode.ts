import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import {
  stampOpenCodeSessionHeader,
  withOpenCodeAttribution,
} from "../opencode";
import type { AnyRequestTransform } from "../../formats/pipeline";
import { onRequest } from "../../formats/pipeline";
import type { Provider } from "../../types";

// OpenCode Zen - OpenAI-compatible gateway aimed at coding agents.
// Every Chat completion and Responses request carries canonical OpenCode
// attribution headers (`x-opencode-session` + `x-opencode-client: cli`);
// routing, auth, URL, and body shape are unchanged.
class OpenCodeAdapter extends OpenAICompatibleAdapter {
  // Stamp `x-opencode-session` from the CLIENT-shaped body before any format
  // conversion: the converters drop conversation-identity fields
  // (messages->chat loses metadata.user_id), so deriving post-conversion
  // would mint a different session per wire format. One stage per wire
  // format; buildTransformPlan runs exactly the one matching the client
  // format. Headers-only side effect - the body passes through unchanged,
  // and withOpenCodeAttribution below remains the final canonicalizer
  // (strips case variants, applies `cli`, fills the static fallback UUID
  // when the transform found no identity).
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

  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    return super.chatCompletions({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body),
    });
  }

  override responses(ctx: BuildCtx): BuiltRequest {
    return super.responses({
      ...ctx,
      headers: withOpenCodeAttribution(ctx.headers, ctx.body),
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
