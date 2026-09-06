import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind, type ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Charm Hyper ("HyperCharm") - OpenAI/Anthropic-compatible inference at
// https://hyper.charm.land/v1 (chat/completions, messages, responses, models
// all speak standard OpenAI dialect, so the verbatim default build is correct).
// Docs: https://hyper.charm.land/docs/
//
// Auth: Authorization: Bearer sk-hyper-… is the documented scheme on every
// endpoint; /v1/messages additionally accepts x-api-key (its documented
// example uses it), so authScheme "both" sends both headers and is
// compatible everywhere.
//
// Billing is Hypercredits: GET {origin}{basePath}/credits -> { "balance": 100 }.
// The payload has no reset timestamp, so no resetsAt on the window. The bar
// ceiling is the operator-configured creditsPerPeriod (default 100 = free tier).

interface CreditsResp {
  balance?: unknown;
}

// 1 Hypercredit = 5¢ (vendor FAQ, "currently").
const CENTS_PER_CREDIT = 5;

// The API does not expose the operator-configured tier allocation, so it's
// read from the operator's providerConfig.creditsPerPeriod (default = free
// tier's 100 credits/month, matching newapi's readQuota pattern).
function readCreditsPerPeriod(provider: {
  providerConfig?: Record<string, unknown>;
}): number {
  const v = provider.providerConfig?.creditsPerPeriod;
  return typeof v === "number" && v > 0 ? v : 100;
}

class HyperCharmAdapter extends OpenAICompatibleAdapter {
  override supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  // Dollar usage bar from Hypercredit balance. GET /credits returns a bare
  // balance with no limit and no refresh timestamp, so the operator-configured
  // creditsPerPeriod (default 100) is used as the ceiling (newapi.ts pattern).
  override async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled - usage not queried.",
      };
    }

    // resolve() composes origin + the CONFIGURED basePath, so a user-edited
    // base URL is honored (never hardcode the host - same as moonshot.ts).
    let res;
    try {
      res = await ctx.request(ctx.resolve("/credits"), {
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

    if (!res.ok) {
      return {
        windows: [],
        unavailable: true,
        message: `Usage endpoint returned HTTP ${res.status}`,
      };
    }

    let body: CreditsResp;
    try {
      body = res.json() as CreditsResp;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned non-JSON.",
      };
    }

    const balance = body.balance;
    if (typeof balance !== "number" || !Number.isFinite(balance)) {
      return {
        windows: [],
        unavailable: true,
        message: "No credit balance returned.",
      };
    }

    // Compute the dollar bar in integer cents (no resetsAt because /credits
    // carries no refresh timestamp - same reasoning as newapi.ts).
    const creditsPerPeriod = readCreditsPerPeriod(ctx.provider);
    const limitCents = Math.round(Math.max(creditsPerPeriod, balance) * CENTS_PER_CREDIT);
    const usedCents = Math.max(0, Math.round(Math.max(0, creditsPerPeriod - balance) * CENTS_PER_CREDIT));
    const window: ProviderKeyUsageWindow = {
      id: "hypercredits",
      label: "Balance",
      used: usedCents / 100,
      limit: limitCents / 100,
      unit: "dollars",
    };

    // Integers render verbatim ("87"); fractions get two decimals ("12.50").
    const fmt = Number.isInteger(balance)
      ? String(balance)
      : balance.toFixed(2);
    const line = `${fmt} Hypercredits remaining`;
    return {
      windows: [window],
      message:
        balance <= 0 ? `${line} - insufficient for API calls` : line,
    };
  }
}

export const hypercharm = new HyperCharmAdapter({
  id: "hypercharm",
  label: "HyperCharm",
  blurb:
    "Charm Hyper inference for coding agents - OpenAI/Anthropic-compatible API with Hypercredit billing.",
  brand: "hypercharm",
  docsUrl: "https://hyper.charm.land/docs/",
  defaults: {
    baseUrl: "https://hyper.charm.land",
    basePath: "/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat, WireKind.Messages, WireKind.Responses],
    authScheme: "both",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "hypercharm",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
      hint: "sk-hyper-… key from the Hyper dashboard. One per line - rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://hyper.charm.land",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
