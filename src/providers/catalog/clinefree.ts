import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
  type ModelsCtx,
  type TestModelCtx,
  type TestModelResult,
  type TestProviderCtx,
  type TestProviderResult,
} from "../base";
import { WireKind } from "../../types";
import type { UpstreamModel } from "../../formats/wire/models";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import {
  STATIC_CLINE_FREE_MODELS,
  clineFingerprintHeaders,
  parseClineFreeModels,
} from "../clinefree";

class ClineFreeAdapter extends OpenAICompatibleAdapter {
  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    if (!ctx.apiKey) throw new Error("Cline Free authentication is missing");
    return {
      url: ctx.resolve(),
      headers: {
        ...ctx.headers,
        ...clineFingerprintHeaders(ctx.apiKey),
      },
      body: ctx.body,
    };
  }

  override async fetchModels(ctx: ModelsCtx): Promise<UpstreamModel[]> {
    try {
      const transport = ctx.transport;
      if (!transport) return STATIC_CLINE_FREE_MODELS;
      const response = await transport(ctx.url, {
        headers: { accept: "application/json" },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!response.ok) return STATIC_CLINE_FREE_MODELS;
      const models = parseClineFreeModels(await response.json());
      return models.length ? models : STATIC_CLINE_FREE_MODELS;
    } catch {
      return STATIC_CLINE_FREE_MODELS;
    }
  }

  override async testModel(ctx: TestModelCtx): Promise<TestModelResult> {
    return this.probeEndpoint(ctx, WireKind.Chat);
  }

  override async testProvider(
    ctx: TestProviderCtx,
  ): Promise<TestProviderResult> {
    const model = STATIC_CLINE_FREE_MODELS[0].id;
    const result = await this.testModel({
      ...ctx,
      model,
      keyMetadata: {},
    } as TestModelCtx);
    return {
      ok: result.ok,
      status: result.status,
      ms: result.ms,
      ...(result.ok
        ? { sample: JSON.stringify(result.data).slice(0, 240) }
        : { error: String(result.data) }),
    };
  }
}

export const clinefree = new ClineFreeAdapter({
  id: "clinefree",
  label: "Cline Free",
  blurb: "Cline's free AI models with browser device authentication.",
  brand: "cline",
  docsUrl: "https://cline.bot/",
  authentication: {
    kind: "oauth",
    flow: "device_code",
    title: "Connect Cline",
    description:
      "Sign in through Cline's secure device flow to use the currently available free models.",
    actionLabel: "Connect Cline account",
  },
  defaults: {
    baseUrl: "https://api.cline.bot",
    basePath: "/api/v1",
    modelsPath: "/ai/cline/recommended-models",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "clinefree",
      required: true,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: false,
      hint: "Managed by the Cline Free integration.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
