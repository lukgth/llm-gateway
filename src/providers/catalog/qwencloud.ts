import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// QwenCloud Token Plan (international, Singapore region).
//
// Inference base URL: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
// Anthropic-format endpoint: /apps/anthropic (sibling path, NOT under compatible-mode/v1)
// Auth for inference: Authorization: Bearer <api-key>

class QwenCloudAdapter extends OpenAICompatibleAdapter {
  // The Anthropic-format endpoint lives at a sibling path to compatible-mode:
  // <origin>/apps/anthropic — not under <origin>/compatible-mode/v1.
  // ctx.baseUrl is just the origin (e.g. https://token-plan...aliyuncs.com)
  // since the /compatible-mode/v1 prefix is carried in ctx.basePath; so we
  // can append to ctx.baseUrl directly.
  //
  // Alibaba documents /apps/anthropic as the ANTHROPIC_BASE_URL — a BASE the
  // client appends the Messages path to, not an endpoint itself. Verified live
  // on both regions: POST /apps/anthropic/v1/messages -> 401 (auth reached) on
  // each, while the bare /apps/anthropic -> 404 on cn-beijing. Both hosts route
  // before they authenticate (a nonsense path -> 404), so that 404 is a real
  // miss, and the bare path only appeared to work on ap-southeast-1 because
  // that region answers the prefix with a 401 instead.
  override messages(ctx: BuildCtx): BuiltRequest {
    const url = ctx.baseUrl.replace(/\/+$/, "") + "/apps/anthropic/v1/messages";
    return { url, headers: ctx.headers, body: ctx.body };
  }
}

export const qwencloud = new QwenCloudAdapter({
  id: "qwencloud",
  label: "QwenCloud Token Plan",
  blurb:
    "Alibaba QwenCloud Token Plan subscription — OpenAI-compatible and Anthropic-compatible endpoints.",
  brand: "qwen",
  docsUrl: "https://help.aliyun.com/",
  defaults: {
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
    basePath: "/compatible-mode/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat, WireKind.Responses, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "qwencloud",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://token-plan.ap-southeast-1.maas.aliyuncs.com",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});

// Same product, mainland China region. Identical path layout (including the
// /apps/anthropic sibling), so it reuses QwenCloudAdapter — only the host differs.
//
// Inference base URL: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
// Anthropic-format endpoint: https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic
export const qwencloudCn = new QwenCloudAdapter({
  id: "qwencloud-cn",
  label: "QwenCloud Token Plan (CN)",
  blurb:
    "Alibaba QwenCloud Token Plan subscription, mainland China region — OpenAI-compatible and Anthropic-compatible endpoints.",
  brand: "qwen",
  docsUrl: "https://help.aliyun.com/zh/model-studio/token-plan-overview",
  defaults: {
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com",
    basePath: "/compatible-mode/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat, WireKind.Responses, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "qwencloud-cn",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
      hint: "One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://token-plan.cn-beijing.maas.aliyuncs.com",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
