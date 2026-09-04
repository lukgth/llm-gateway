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
import { WireKind, type Provider } from "../../types";
import type {
  AnyRequestTransform,
  AnyResponseTransform,
  AnyStreamTransform,
} from "../../formats/pipeline";
import { onRequest, onResponse } from "../../formats/pipeline";
import {
  DSML_COMPAT_META,
  DsmlChatStreamTransform,
  parseDsmlToolCalls,
} from "../../formats/dsml";
import type { UpstreamModel } from "../../formats/wire/models";
import {
  STATIC_CLINE_FREE_MODELS,
  clineFingerprintHeaders,
  parseClineFreeModels,
} from "../clinefree";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUsableArguments(value: unknown): boolean {
  return typeof value === "string" && value !== "" && value !== "{}";
}

function healBufferedChat(body: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choiceValue of choices) {
    if (!isObject(choiceValue) || !isObject(choiceValue.message)) continue;
    const message = choiceValue.message;
    if (typeof message.content !== "string") continue;
    const parsed = parseDsmlToolCalls(message.content);
    if (!parsed.calls.length) continue;
    const native = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
    const toolCalls = [...native];
    parsed.calls.forEach((call, index) => {
      const existing = toolCalls[index];
      if (existing && isObject(existing.function) && existing.function.name === call.name) {
        if (!hasUsableArguments(existing.function.arguments)) existing.function.arguments = call.arguments;
        return;
      }
      toolCalls.push({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } });
    });
    message.content = parsed.text || null;
    message.tool_calls = toolCalls;
    choiceValue.finish_reason = "tool_calls";
  }
  return body;
}
// Provider-local prompt-cache markers for api.cline.bot (Cline wire contract).
// Emits Anthropic-style `cache_control: { type: "ephemeral" }` at the top level
// and on the latest user message. Chat-shaped bodies only; Anthropic-shaped
// bodies (top-level `system`) pass through untouched. Client-supplied markers
// win; never emits `prompt_cache_retention` / `prompt_cache_key`.
function applyClineFreePromptCache(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (body.system !== undefined) return body;
  if (!Array.isArray(body.messages)) return body;
  if (body.cache_control === undefined) {
    body.cache_control = { type: "ephemeral" };
  }
  const messages = body.messages as unknown[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isObject(msg)) continue;
    if (msg.role !== "user") continue;
    if (msg.cache_control === undefined) {
      msg.cache_control = { type: "ephemeral" };
    }
    break;
  }
  return body;
}

class ClineFreeAdapter extends OpenAICompatibleAdapter {
  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    if (!ctx.apiKey) throw new Error("Cline Free authentication is missing");
    return {
      url: ctx.url,
      headers: {
        ...ctx.headers,
        ...clineFingerprintHeaders(ctx.apiKey),
      },
      body: ctx.body,
    };
  }

  override requestTransforms(_provider: Provider): AnyRequestTransform[] {
    return [
      onRequest("chat", "clinefree:prompt-cache", (body) =>
        applyClineFreePromptCache(
          body as unknown as Record<string, unknown>,
        ) as never,
      ),
    ];
  }

  // Temporary compatibility workaround: api.cline.bot currently leaks DeepSeek V4 DSML tool markup and wraps buffered completions; remove this adapter-specific healing once Cline's serving path decodes DSML and returns standard OpenAI responses.
  override responseTransforms(_provider: Provider): AnyResponseTransform[] {
    return [
      onResponse("chat", "clinefree:unwrap-response", (body) => {
        const data = (body as Record<string, unknown>).data;
        if (isObject(data) && Array.isArray(data.choices)) return data as never;
        return body;
      }),
      onResponse(
        "chat",
        "clinefree:dsml-tool-calls",
        (body) => healBufferedChat(body as unknown as Record<string, unknown>) as never,
        DSML_COMPAT_META,
      ),
    ];
  }

  // Temporary compatibility workaround: api.cline.bot currently leaks DeepSeek V4 DSML tool markup; remove this adapter-specific healing once Cline's serving path decodes DSML and returns standard OpenAI tool calls.
  override streamTransforms(_provider: Provider): AnyStreamTransform[] {
    return [
      {
        name: "clinefree:dsml-tool-calls",
        phase: "response",
        format: "chat",
        create: () => new DsmlChatStreamTransform(),
        ...DSML_COMPAT_META,
      },
    ];
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
    return this.probeEndpoint(ctx, WireKind.Chat, {
      body: {
        model: ctx.model,
        max_tokens: 2048,
        messages: [{ role: "user", content: "Reply with one word." }],
      },
    });
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
});
