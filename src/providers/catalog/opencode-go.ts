import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// OpenCode Go - a paid subscription tier at opencode.ai/go, distinct from Zen.
// Supports both /chat/completions and /messages.
//
// Quota via GET {origin}/v1/usage with `Authorization: Bearer <apiKey>`.
// Response:
//   { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
// No key metadata required.

const USAGE_PATH = "/v1/usage";

interface WindowLike {
  status: string;
  percent?: number;
  resetsAt?: string;
}

function windowFrom(
  id: string,
  label: string,
  w?: WindowLike,
): ProviderKeyUsageWindow | null {
  if (!w || w.status !== "ok") return null;
  const used = w.percent;
  const resetsAt = w.resetsAt;
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    typeof resetsAt !== "string" ||
    Number.isNaN(Date.parse(resetsAt))
  )
    return null;
  return { id, label, used, limit: 100, unit: "percent", resetsAt };
}

class OpenCodeGoAdapter extends OpenAICompatibleAdapter {
  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled - usage not queried.",
      };
    }

    let res;
    try {
      res = await ctx.request(ctx.resolve(USAGE_PATH), {
        method: "GET",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          accept: "application/json",
        },
        signal: ctx.signal,
      });
    } catch (err) {
      return {
        windows: [],
        unavailable: true,
        message: `Usage query failed: ${(err as Error).message}`,
      };
    }

    // Parse before branching on status: the failure body carries the upstream's
    // own message ("Unauthorized"), which is far more useful to an operator
    // than a bare "HTTP 401".
    let data:
      | { usage?: Record<string, WindowLike>; error?: { message?: string } }
      | null = null;
    try {
      data = res.json() as {
        usage?: Record<string, WindowLike>;
        error?: { message?: string };
      } | null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const upstream = data?.error?.message;
      return {
        windows: [],
        unavailable: true,
        message: upstream
          ? `Usage endpoint: ${upstream} (HTTP ${res.status})`
          : `Usage endpoint returned HTTP ${res.status}`,
      };
    }

    if (!data || typeof data !== "object") {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }

    const usage = data.usage ?? {};

    const windows: ProviderKeyUsageWindow[] = [];
    const w1 = windowFrom("rolling-5h", "Prompts (5h)", usage.rolling);
    if (w1) windows.push(w1);
    const w2 = windowFrom("weekly", "Prompts (weekly)", usage.weekly);
    if (w2) windows.push(w2);
    const w3 = windowFrom("monthly", "Prompts (monthly)", usage.monthly);
    if (w3) windows.push(w3);

    if (windows.length === 0) {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse quota data.",
      };
    }

    return { windows };
  }
}

export const opencodeGo = new OpenCodeGoAdapter({
  id: "opencode-go",
  label: "OpenCode Go",
  blurb:
    "OpenCode Go subscription - both /chat/completions and /messages endpoints.",
  brand: "opencode",
  docsUrl: "https://opencode.ai/docs/go/",
  defaults: {
    baseUrl: "https://opencode.ai/zen/go",
    endpoints: [WireKind.Chat, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "opencode-go",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
      hint: "One per line - rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://opencode.ai/zen/go",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});