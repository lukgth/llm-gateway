import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind, type Provider } from "../../types";
import type { Json, RequestTransform } from "../../formats/pipeline";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Moonshot Kimi (mainland China endpoint).
//
// Inference base URL: https://api.moonshot.cn/v1
// Anthropic-format endpoint: /anthropic (sibling path, NOT under /v1)
// Auth: Authorization: Bearer <api-key>
//
// The international host is https://api.moonshot.ai with the same path layout,
// so switching regions is just an edit of the (editable) base URL field.

// Kimi models are pinned to temperature 1.
//
// Matched on the UPSTREAM model id (ctx.upstreamModel — the id actually sent to
// this provider), not the exposed alias: an alias can be named anything, so
// keying off it would both miss real kimi-* hops and fire on non-Kimi ones.
// Falls back to the body's own `model` for the handful of TransformCtx call
// sites that carry no upstreamModel (unit tests, the SSE-only stream path).
//
// Runs on the request stage, so it applies to every wire kind this provider
// serves — chat and messages alike — and after format conversion, so it sets
// the field on the body actually going upstream.
const forceKimiTemperature: RequestTransform = {
  name: "moonshot-kimi-temperature",
  label: "Kimi temperature = 1",
  blurb:
    "Forces temperature to 1 on kimi-* models, replacing any client-supplied value.",
  apply: (body: Json, ctx): Json => {
    if (!body || typeof body !== "object") return body;
    const model =
      ctx.upstreamModel ??
      (typeof body.model === "string" ? body.model : undefined);
    if (!model?.toLowerCase().startsWith("kimi-")) return body;
    body.temperature = 1;
    return body;
  },
};

class MoonshotAdapter extends OpenAICompatibleAdapter {
  override requestTransforms(p: Provider): RequestTransform[] {
    return [...super.requestTransforms(p), forceKimiTemperature];
  }

  // The Anthropic-format endpoint is a sibling of /v1 — <origin>/anthropic,
  // not <origin>/v1/anthropic. ctx.baseUrl is just the origin (the /v1 prefix
  // is carried in ctx.basePath), so append directly to it.
  //
  // `/anthropic` is the ANTHROPIC_BASE_URL Moonshot documents, i.e. a BASE that
  // the client appends the Messages path to — the bare path is not itself an
  // endpoint. Verified against the live host: POST /anthropic -> 404, POST
  // /anthropic/v1/messages -> 401 (auth reached), and a nonsense path -> 404,
  // so this host routes before it authenticates and that 404 is a real miss.
  override messages(ctx: BuildCtx): BuiltRequest {
    const url = ctx.baseUrl.replace(/\/+$/, "") + "/anthropic/v1/messages";
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
