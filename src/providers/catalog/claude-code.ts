// Claude Code subscription provider.
//
// Same upstream as the official Anthropic provider (/v1/messages), but its
// adapter wires in the Claude Code request-processing stack from
// formats/anthropic/subscription/index.ts: classifier scrubbing, tool-name
// normalization (PascalCase + decoy stubs), and OAuth billing/attestation
// (cch header computation). Response and stream transforms reverse tool
// renames so the client sees its original tool names.
//
// Managed-auth, import-only (same UX pattern as openai-codex.ts): the admin
// pastes either the Claude Code OAuth credential JSON or a bare long-lived
// sk-ant-oat01-... token - see
// services/provider-auth/integrations/claude-code.ts, which detects the
// shape, VALIDATES it with a real upstream call, and stores it accordingly.
// A plain sk-ant-api03-... Console key is deliberately rejected here - that
// belongs to the Anthropic provider (./anthropic.ts), not this one. The
// gateway manages refresh for refreshable OAuth credentials automatically;
// long-lived tokens never need it. Every credential kind still flows through
// the SAME request-processing stack below unchanged - that stack already
// applies uniformly regardless of what's authenticating the request.

import {
  AnthropicCompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import type {
  RequestTransform,
  ResponseTransform,
  StreamTransform,
} from "../../formats/pipeline";
import type { AnthropicMessagesRequest } from "../../formats/wire";
import {
  finalizeClaudeCodeRequest,
  subscriptionRequestStack,
  subscriptionResponseStack,
  subscriptionStreamStack,
} from "../../formats/anthropic/subscription/index";
import { WireKind, type Provider, type ProviderKeyUsageWindow } from "../../types";
import { ANTHROPIC_DEFAULT_TRANSFORMS } from "./anthropic-compatible";
import { withBetaQuery } from "../../formats/anthropic/subscription/billing";
import {
  parseUnifiedRateLimitHeaders,
  unifiedRateLimitToUsageWindows,
  unifiedStatusMessage,
} from "../../services/anthropic/unified-usage";
import {
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_OAUTH_USAGE_URL,
} from "../claude-code-oauth";

class ClaudeCodeAdapter extends AnthropicCompatibleAdapter {
  requestTransforms(p: Provider): RequestTransform[] {
    return [...super.requestTransforms(p), ...subscriptionRequestStack];
  }

  responseTransforms(p: Provider): ResponseTransform[] {
    return [...super.responseTransforms(p), ...subscriptionResponseStack];
  }

  streamTransforms(p: Provider): StreamTransform[] {
    return [...super.streamTransforms(p), ...subscriptionStreamStack];
  }

  messages(ctx: BuildCtx): BuiltRequest {
    const finalized = finalizeClaudeCodeRequest(
      ctx.body as AnthropicMessagesRequest,
    );
    ctx.headers["x-claude-code-session-id"] = finalized.sessionId;
    ctx.headers["x-anthropic-billing-header"] = finalized.billingHeader;
    const built = super.messages({ ...ctx, body: finalized.body });
    built.url = withBetaQuery(built.url);
    return built;
  }

  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  // Proactive quota query, when the credential can support one: only a
  // profile-scoped OAuth credential (user:profile) can call
  // /api/oauth/usage - a user:inference-only long-lived token and a plain
  // API key have no such endpoint (confirmed against Claude Code's own
  // client: fetchUtilization() gates on hasProfileScope() the same way).
  // Falls back to the existing passive header-snapshot path
  // (unified-usage.ts) when unavailable or the live query itself fails, so
  // every credential kind still gets *something* rather than a hard error.
  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    const scopesRaw = ctx.keyMetadata?.scopes;
    const scopes = scopesRaw ? scopesRaw.split(",").map((s) => s.trim()) : [];
    const canQueryUsage =
      ctx.enabled &&
      ctx.keyMetadata?.authKind === "oauth_token" &&
      scopes.includes("user:profile");

    if (canQueryUsage) {
      const live = await this.queryOAuthUsage(ctx);
      if (live) return live;
    }
    return this.passiveKeyUsage(ctx);
  }

  private async queryOAuthUsage(ctx: UsageCtx): Promise<KeyUsageResult | undefined> {
    let res: Awaited<ReturnType<UsageCtx["request"]>>;
    try {
      res = await ctx.request(CLAUDE_OAUTH_USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
          "content-type": "application/json",
        },
        signal: ctx.signal,
      });
    } catch {
      return undefined; // fall back to the passive path rather than erroring
    }
    if (!res.ok) return undefined;

    let body: unknown;
    try {
      body = res.json();
    } catch {
      return undefined;
    }
    if (!body || typeof body !== "object") return undefined;

    const windows = usageWindowsFromOAuthUsage(body as Record<string, unknown>);
    if (!windows.length) return undefined;

    const planLabel = ctx.keyMetadata?.subscriptionType;
    const message =
      planLabel && planLabel.trim()
        ? `Plan: ${planLabel.trim().charAt(0).toUpperCase()}${planLabel.trim().slice(1).toLowerCase()}`
        : undefined;
    return { windows, ...(message ? { message } : {}), dummy: false };
  }

  private passiveKeyUsage(ctx: UsageCtx): KeyUsageResult {
    if (!ctx.unifiedUsage) {
      return {
        windows: [],
        unavailable: true,
        message:
          ctx.keyMetadata?.authKind === "api_key" ||
          (ctx.keyMetadata?.tokenKind === "long_lived" &&
            !ctx.keyMetadata?.scopes?.includes("user:profile"))
            ? "No proactive usage endpoint for this credential - usage is observed passively after a request. No usage captured yet - send a request with this key."
            : "No usage captured yet - send a request with this key.",
      };
    }
    const info = parseUnifiedRateLimitHeaders(ctx.unifiedUsage.headers);
    if (!info) {
      return {
        windows: [],
        unavailable: true,
        message: "The latest response did not contain unified usage headers.",
      };
    }
    return {
      windows: unifiedRateLimitToUsageWindows(info),
      message: unifiedStatusMessage(info),
      dummy: false,
    };
  }
}

// GET /api/oauth/usage response shape (src/services/api/usage.ts's
// Utilization type): { five_hour, seven_day, seven_day_opus,
// seven_day_sonnet, extra_usage }, each a plain { utilization: 0-100,
// resets_at: ISO } pair (or an ExtraUsage variant) - already the exact units
// ProviderKeyUsageWindow wants, no raw-seconds reset math needed (unlike
// Codex's wham/usage).
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "Session (5h)",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
};

function usageWindowsFromOAuthUsage(
  body: Record<string, unknown>,
): ProviderKeyUsageWindow[] {
  const windows: ProviderKeyUsageWindow[] = [];
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const raw = body[key];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const used = entry.utilization;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const resetsAt = typeof entry.resets_at === "string" ? entry.resets_at : undefined;
    windows.push({
      id: key,
      label,
      used,
      limit: 100,
      unit: "percent",
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const extra = body.extra_usage;
  if (extra && typeof extra === "object") {
    const e = extra as Record<string, unknown>;
    if (e.is_enabled === true && typeof e.utilization === "number") {
      windows.push({
        id: "extra_usage",
        label: "Extra usage",
        used: e.utilization,
        limit: 100,
        unit: "percent",
      });
    }
  }
  return windows;
}

export const claudeCode = new ClaudeCodeAdapter({
  id: "claude-code",
  label: "Claude Code",
  blurb: "Anthropic Messages endpoint with Claude Code OAuth spoofing.",
  brand: "claude",
  docsUrl: "https://docs.anthropic.com/en/api",
  authentication: {
    kind: "oauth",
    flow: "import",
    title: "Connect Claude Code",
    description:
      "Import Claude Code credential JSON (the claudeAiOauth object) or paste one or more long-lived sk-ant-oat01-… OAuth tokens, one per line.",
    actionLabel: "Import Claude Code credentials",
  },
  defaults: {
    baseUrl: "https://api.anthropic.com",
    endpoints: [WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "claude-code",
      required: true,
    },
  ],
  quirks: {
    requiredHeaders: { "anthropic-version": "2023-06-01" },
    thinking: { defaultType: "adaptive", supportsEffort: true },
    // Same Anthropic-family base as anthropic.ts - see
    // ANTHROPIC_DEFAULT_TRANSFORMS's doc comment in anthropic-compatible.ts.
    // The subscription no-op stack (subscriptionRequestStack, above) is a
    // separate untagged requestTransforms() addition, not a quirks default -
    // it has no ModelTransformConfig shape (no library transform backs it),
    // so it can't be seeded/shown the same way; it still appears in the
    // resolved-transforms view as an adapter-level stage (see
    // docs/transforms-api.md).
    defaultTransforms: ANTHROPIC_DEFAULT_TRANSFORMS,
  },
});
