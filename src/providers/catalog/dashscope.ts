import { OpenAICompatibleAdapter } from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Alibaba Cloud Model Studio's normal pay-as-you-go DashScope API. This is
// separate from the QwenCloud Token Plan and DashScope Coding Plan: it uses a
// regional Model Studio key and the standard OpenAI-compatible endpoints.
//
// New keys should use the workspace-specific API host shown in Model Studio.
// The mainland China host is the default. Users in other regions can replace
// the editable origin with the workspace-specific API host shown in Model Studio.
// The key and host must belong to the same region.
export const dashscope = new OpenAICompatibleAdapter({
  id: "dashscope",
  label: "DashScope (Pay-as-you-go)",
  blurb:
    "Alibaba Cloud Model Studio pay-as-you-go API - OpenAI-compatible Chat Completions and Responses, separate from Token Plan and Coding Plan.",
  brand: "qwen",
  docsUrl:
    "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
  defaults: {
    baseUrl: "https://dashscope.aliyuncs.com",
    basePath: "/compatible-mode/v1",
    // OpenAI-compatible discovery convention. Availability can vary by regional
    // workspace host, so users can still add models manually if this route fails.
    modelsPath: "/models",
    endpoints: [WireKind.Chat, WireKind.Responses],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "dashscope",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-ws-… or sk-…",
      required: true,
      hint: "Pay-as-you-go Model Studio key, not a Coding Plan key (sk-sp-…). Keys are region-specific. One per line - rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://dashscope.aliyuncs.com. For workspace-specific keys, use the API host shown in Model Studio and keep it in the key's region. Enter only the origin; /compatible-mode/v1 is added automatically.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
