import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Moonshot Kimi (mainland China endpoint).
//
// Inference base URL: https://api.moonshot.cn/v1
// Anthropic-format endpoint: /anthropic (sibling path, NOT under /v1)
// Auth: Authorization: Bearer <api-key>
//
// The international host is https://api.moonshot.ai with the same path layout,
// so switching regions is just an edit of the (editable) base URL field.

class MoonshotAdapter extends OpenAICompatibleAdapter {
  // The Anthropic-format endpoint is a sibling of /v1 — <origin>/anthropic,
  // not <origin>/v1/anthropic. ctx.baseUrl is just the origin (the /v1 prefix
  // is carried in ctx.basePath), so append directly to it. Same shape as the
  // qwencloud /apps/anthropic override.
  override messages(ctx: BuildCtx): BuiltRequest {
    const url = ctx.baseUrl.replace(/\/+$/, "") + "/anthropic";
    return { url, headers: ctx.headers, body: ctx.body };
  }
}

export const moonshot = new MoonshotAdapter({
  id: "moonshot",
  label: "Moonshot Kimi",
  blurb:
    "Moonshot AI Kimi — OpenAI-compatible and Anthropic-compatible endpoints.",
  brand: "kimi",
  docsUrl: "https://platform.moonshot.cn/docs",
  defaults: {
    baseUrl: "https://api.moonshot.cn",
    basePath: "/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "moonshot",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-…",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://api.moonshot.cn — use https://api.moonshot.ai for the international endpoint.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
