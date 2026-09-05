import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import { withOpenCodeAttribution } from "../opencode";

// OpenCode Zen - OpenAI-compatible gateway aimed at coding agents.
// Every Chat completion carries canonical OpenCode attribution headers
// (`x-opencode-session` + `x-opencode-client: cli`); routing, endpoints,
// auth, URL, and body shape are unchanged.
class OpenCodeAdapter extends OpenAICompatibleAdapter {
  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    return super.chatCompletions({
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
    endpoints: [WireKind.Chat],
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
