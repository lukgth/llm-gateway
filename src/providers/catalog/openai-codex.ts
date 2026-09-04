// OpenAI Codex - ChatGPT-subscription access to Codex models.
//
// Routes OpenAI-compatible chat/responses traffic through ChatGPT's internal
// Codex backend (https://chatgpt.com/backend-api/codex) using a managed OAuth
// account imported from an existing Codex auth.json or ChatGPT session cookie
// (see services/provider-auth/integrations/codex.ts). The stock `openai`
// catalog entry stays API-key-only; this adapter never carries API keys.
//
// Identity replication: the backend expects the official Codex CLI's client
// identity, so every outbound request is pinned to the same defaults the CLI
// sends - originator/version/user-agent plus the account-scoped bearer +
// chatgpt-account-id auth headers. The exact values live in ../codex.ts
// (one home shared with the managed-auth integration). A client can neither
// replace nor case-variant its way past them: all five header names are
// stripped case-insensitively before the canonical values are set.

import {
  OpenAICompatibleAdapter,
  type AdapterHttpResponse,
  type BuildCtx,
  type BuiltRequest,
  type KeyUsageResult,
  type ModelsCtx,
  type UsageCtx,
} from "../base";
import { WireKind, type ProviderKeyUsageWindow } from "../../types";
import type { UpstreamModel } from "../../formats/wire/models";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";
import { CODEX_CLIENT_VERSION, codexIdentityHeaders, parseCodexModels } from "../codex";

// Sibling path of the Codex base path — NOT under /backend-api/codex but
// at /backend-api/wham/usage (sibling of the codex api family).
const CODEX_USAGE_PATH = "/backend-api/wham/usage";

class OpenAICodexAdapter extends OpenAICompatibleAdapter {
  // The Codex backend speaks Responses natively for every model; per-link
  // endpoint pins still win via routeFor (preferredEndpoint is skipped when
  // one is set).
  override preferredEndpoint(
    _model: string,
    _accepted: WireKind[],
  ): WireKind | undefined {
    return WireKind.Responses;
  }

  // Remove EVERY case variant of the headers this provider owns before
  // setting canonical values - HTTP header names are case-insensitive, and an
  // inbound client could otherwise smuggle `Originator:`/`VERSION:` etc.
  // past the exact lowercase keys written below.
  private stripConflicting(headers: Record<string, string>): void {
    const owned = [
      "authorization",
      "originator",
      "version",
      "user-agent",
      "chatgpt-account-id",
    ];
    for (const key of Object.keys(headers)) {
      if (owned.includes(key.toLowerCase())) delete headers[key];
    }
  }

  // One shared build path for both wire kinds: canonical Codex identity +
  // account headers on top of the engine-composed set (which carried the
  // bearer Authorization from the selected managed credential).
  private codexBuild(ctx: BuildCtx): BuiltRequest {
    this.stripConflicting(ctx.headers);
    Object.assign(ctx.headers, codexIdentityHeaders());
    if (ctx.apiKey)
      ctx.headers["authorization"] = `Bearer ${ctx.apiKey}`;
    const accountId = ctx.keyMetadata?.accountId;
    if (accountId) ctx.headers["chatgpt-account-id"] = accountId;
    return { url: ctx.url, headers: ctx.headers, body: ctx.body };
  }

  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    return this.codexBuild(ctx);
  }

  override responses(ctx: BuildCtx): BuiltRequest {
    // The CLI always sends store:false with a non-empty instructions field;
    // subscription-backed requests reject stored responses.
    ctx.body["store"] = false;
    if (typeof ctx.body["instructions"] !== "string")
      ctx.body["instructions"] = "";
    if (typeof ctx.body["input"] === "string") {
      const input = ctx.body["input"];
      ctx.body["input"] = [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: input }],
        },
      ];
    }
    return this.codexBuild(ctx);
  }

  // GET /models?client_version=… through the supplied proxy/TLS-aware
  // transport, with full Codex identity + account headers (the backend lists
  // only the authenticated subscription's models).
  override async fetchModels(ctx: ModelsCtx): Promise<UpstreamModel[]> {
    if (!ctx.transport) throw new Error("No model-list transport configured");
    const headers: Record<string, string> = { ...ctx.headers };
    this.stripConflicting(headers);
    Object.assign(headers, codexIdentityHeaders(), {
      accept: "application/json",
    });
    if (ctx.apiKey) headers["authorization"] = `Bearer ${ctx.apiKey}`;
    const accountId = ctx.keyMetadata?.accountId;
    if (accountId) headers["chatgpt-account-id"] = accountId;

    const response = await ctx.transport(
      `${ctx.resolve(`/models?client_version=${CODEX_CLIENT_VERSION}`)}`,
      {
        headers,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    if (!response.ok)
      throw new Error(`Model discovery failed (${response.status})`);
    const models = parseCodexModels(await response.json());
    if (!models.length) throw new Error("Codex returned no usable models");
    return models;
  }

  // GET /backend-api/wham/usage — sibling of the codex base path, not under
  // it. Reports the current session (primary) and weekly (secondary) quota
  // windows as percentage bars for the usage dashboard.
  override supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  override async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled - usage not queried.",
      };
    }

    const url = `${ctx.baseUrl.replace(/\/+$/, "")}${CODEX_USAGE_PATH}`;
    const headers: Record<string, string> = {};
    this.stripConflicting(headers);
    Object.assign(headers, codexIdentityHeaders(), {
      accept: "application/json",
    });
    headers["authorization"] = `Bearer ${ctx.apiKey}`;
    const accountId = ctx.keyMetadata?.accountId;
    if (accountId) headers["chatgpt-account-id"] = accountId;

    let res: AdapterHttpResponse;
    try {
      res = await ctx.request(url, {
        method: "GET",
        headers,
        signal: ctx.signal,
      });
    } catch (e) {
      return {
        windows: [],
        unavailable: true,
        message: `Usage query failed: ${e}`,
      };
    }

    let body: unknown;
    try {
      body = res.json();
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned non-JSON response.",
      };
    }

    if (!res.ok) {
      const errBody = body as Record<string, unknown>;
      const msg: unknown =
        (errBody?.error as Record<string, unknown>)?.message ??
        errBody?.message;
      return {
        windows: [],
        unavailable: true,
        message:
          typeof msg === "string" && msg.length > 0
            ? msg
            : `Usage endpoint returned HTTP ${res.status}`,
      };
    }

    const rateLimit =
      body && typeof body === "object"
        ? (body as Record<string, unknown>)["rate_limit"]
        : undefined;
    if (!rateLimit || typeof rateLimit !== "object") {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse Codex quota data.",
      };
    }

    const rl = rateLimit as Record<string, unknown>;
    const windows: ProviderKeyUsageWindow[] = [];

    const windowDefs: Array<{
      key: string;
      id: string;
      label: string;
    }> = [
      { key: "primary_window", id: "session", label: "Session" },
      { key: "secondary_window", id: "weekly", label: "Weekly" },
    ];

    for (const def of windowDefs) {
      const w = rl[def.key];
      if (!w || typeof w !== "object") continue;
      const win = w as Record<string, unknown>;
      const usedVal = win["used_percent"];
      if (usedVal === undefined || usedVal === null) continue;
      const used = typeof usedVal === "number" ? usedVal : Number(usedVal);
      if (!Number.isFinite(used)) continue;

      let resetsAt: string | undefined;
      const resetAt = win["reset_at"];
      if (typeof resetAt === "number" && resetAt > 0) {
        // Unix timestamp: > 1e11 means milliseconds, otherwise seconds
        resetsAt = new Date(
          resetAt * (resetAt > 1e11 ? 1 : 1000),
        ).toISOString();
      } else if (typeof resetAt === "string" && resetAt.length > 0) {
        const d = new Date(resetAt);
        if (!isNaN(d.getTime())) resetsAt = d.toISOString();
      }
      if (!resetsAt) {
        const resetAfter = win["reset_after_seconds"];
        if (typeof resetAfter === "number" && resetAfter > 0) {
          resetsAt = new Date(Date.now() + resetAfter * 1000).toISOString();
        }
      }

      windows.push({
        id: def.id,
        label: def.label,
        used,
        limit: 100,
        unit: "percent",
        resetsAt,
      });
    }

    if (windows.length === 0) {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse Codex quota data.",
      };
    }

    return { windows };
  }
}

export const openaiCodex = new OpenAICodexAdapter({
  id: "openai-codex",
  label: "OpenAI Codex",
  blurb:
    "ChatGPT subscription access to Codex models via your logged-in account.",
  brand: "openai",
  docsUrl: "https://developers.openai.com/codex",
  authentication: {
    kind: "oauth",
    flow: "import",
    title: "Connect OpenAI Codex",
    description: "Import Codex auth.json or a ChatGPT session cookie.",
    actionLabel: "Import Codex credentials",
  },
  defaults: {
    baseUrl: "https://chatgpt.com",
    basePath: "/backend-api/codex",
    modelsPath: "/models",
    endpoints: [WireKind.Responses, WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "openai-codex",
      required: true,
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: false,
      hint: "Managed by the OpenAI Codex integration.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
