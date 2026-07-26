import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
  type ModelsCtx,
  type TestProviderCtx,
  type TestProviderResult,
} from "../base";
import type { UpstreamModel } from "../../formats/wire/models";
import { WireKind } from "../../types";
import { CC_VERSION } from "../../formats/anthropic/subscription/billing";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Alibaba DashScope Coding Plan — the subscription sold for coding agents
// (Claude Code, Qwen Code, Cline), keyed with an `sk-sp-…` credential that is
// distinct from a pay-as-you-go Model Studio key.
//
// Verified live against the mainland host (a nonsense path -> 404, so these
// hosts route before they authenticate and a 401 means the route is real):
//   GET  /v1/models                  -> 200 (returns the plan's model list)
//   POST /v1/chat/completions        -> 401  (route exists, test key rejected)
//   POST /apps/anthropic/v1/messages -> 401
//   POST /v1/responses               -> 404  (not served; omitted from endpoints)
//   POST /apps/anthropic             -> 404  (a BASE, not an endpoint)
//
// Two regional hosts, same path layout:
//   coding.dashscope.aliyuncs.com       mainland (default; the only one whose
//                                       /v1/models answered)
//   coding-intl.dashscope.aliyuncs.com  international (per the published docs;
//                                       its /v1/models 404s, so model discovery
//                                       needs the mainland host or a manual add)
// The base URL stays editable so switching regions is a one-field change.

// Claude Code's own User-Agent. Alibaba documents this plan as a Claude Code
// endpoint and gates it accordingly, so requests identify as the CLI rather
// than passing through whatever UA the calling client happened to send.
// Sourced from the same CC_VERSION constant the Anthropic subscription stack
// uses, so a version bump stays in one place.
const CLAUDE_CODE_UA = `claude-cli/${CC_VERSION} (external, cli)`;

class DashScopeCodingAdapter extends OpenAICompatibleAdapter {
  // The Anthropic-format endpoint is a sibling of /v1: <origin>/apps/anthropic.
  // That bare path is the documented ANTHROPIC_BASE_URL — a BASE the client
  // appends the Messages path to — so the real endpoint is
  // /apps/anthropic/v1/messages (verified: bare path 404s, this one 401s).
  // ctx.baseUrl is just the origin, since /v1 is carried in ctx.basePath.
  override messages(ctx: BuildCtx): BuiltRequest {
    const url = ctx.baseUrl.replace(/\/+$/, "") + "/apps/anthropic/v1/messages";
    return { url, headers: this.withUa(ctx.headers), body: ctx.body };
  }

  // The UA on EVERY outbound request this adapter makes, including the
  // model-list GET and the connectivity probe.
  //
  // quirks.requiredHeaders alone is not enough: it is applied by
  // applyTemplateDefaults at CREATE time, so it only reaches requests whose
  // provider row happened to be written with it. A row created before this
  // provider existed, or one whose extraHeaders an operator edited or cleared
  // in the UI, would silently go back to sending no UA at all. Forcing it here
  // makes it a property of the adapter rather than of persisted state.
  //
  // Still merged UNDER ctx.headers' own auth/host, and a deliberate
  // provider-level `user-agent` in extraHeaders still wins — see withUa.
  private withUa(headers: Record<string, string>): Record<string, string> {
    // Case-insensitive check: a caller-set UA under any casing must not end up
    // duplicated (node emits every distinct key, so "User-Agent" + "user-agent"
    // would put two UA headers on the wire).
    const hasUa = Object.keys(headers).some(
      (k) => k.toLowerCase() === "user-agent",
    );
    return hasUa ? headers : { ...headers, "user-agent": CLAUDE_CODE_UA };
  }

  override async fetchModels(ctx: ModelsCtx): Promise<UpstreamModel[]> {
    return super.fetchModels({ ...ctx, headers: this.withUa(ctx.headers) });
  }

  override async testProvider(
    ctx: TestProviderCtx,
  ): Promise<TestProviderResult> {
    return super.testProvider({ ...ctx, headers: this.withUa(ctx.headers) });
  }

  override chatCompletions(ctx: BuildCtx): BuiltRequest {
    return super.chatCompletions({ ...ctx, headers: this.withUa(ctx.headers) });
  }
}

export const dashscopeCoding = new DashScopeCodingAdapter({
  id: "dashscope-coding",
  label: "DashScope Coding Plan",
  blurb:
    "Alibaba DashScope Coding Plan subscription — OpenAI-compatible and Anthropic-compatible endpoints, sends the Claude Code user-agent.",
  brand: "qwen",
  docsUrl: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
  defaults: {
    baseUrl: "https://coding.dashscope.aliyuncs.com",
    basePath: "/v1",
    modelsPath: "/models",
    // No /v1/responses on this host (404) — offering it would route traffic to
    // an endpoint that doesn't exist.
    endpoints: [WireKind.Chat, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
    extraHeaders: { "user-agent": CLAUDE_CODE_UA },
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "dashscope-coding",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-sp-…",
      required: true,
      hint: "Coding Plan key (sk-sp-…), not a pay-as-you-go Model Studio key. One per line — rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://coding.dashscope.aliyuncs.com — use https://coding-intl.dashscope.aliyuncs.com for the international region.",
    },
  ],
  quirks: {
    // Applied at create/import time, so the UA lands in the saved provider's
    // extraHeaders and is layered onto every outbound request (engine
    // buildHeaders) and every probe (modelsRequestHeaders) alike.
    requiredHeaders: { "user-agent": CLAUDE_CODE_UA },
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
