import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
  type AdapterHttpResponse,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Command Code Provider API - OpenAI- AND Anthropic-compatible endpoints at
// https://api.commandcode.ai/provider/v1 (chat/completions, messages, models).
// Docs: https://commandcode.ai/docs/provider
// Auth: Authorization: Bearer <key> (same key as the CLI / Studio). Streaming
// emits usage at the end of every stream with no opt-in.
//
// Account usage is NOT part of the provider API - it lives on the internal
// /alpha/* endpoints the CLI/Studio use (reverse-engineered from the
// command-code npm bundle, see /tmp/cc-usage.sh):
//   GET {origin}/alpha/whoami                        -> { org: { id, login }, user: { userName } }
//   GET {origin}/alpha/billing/credits?orgId=...     -> { credits: { monthlyCredits, purchasedCredits, freeCredits } }
//   GET {origin}/alpha/billing/subscriptions?orgId=. -> { data: { currentPeriodStart, planId } }
//   GET {origin}/alpha/usage/summary?orgId=...&since= -> { totalCost }
// The billing/usage calls hang off {origin}/alpha - a SIBLING of /provider/v1 -
// so they are built from ctx.baseUrl (like glm.ts's sibling quota path), NOT
// ctx.resolve() (which would compose through basePath).

// orgId is OPTIONAL: org-scoped Studio keys carry org.id (billing/usage calls
// then need ?orgId=...), but plain user-scoped keys (a personal Studio account,
// whoami returns "org": null) hit the same endpoints WITHOUT the org param.

interface CcWhoami {
  org?: { id?: string; login?: string } | null;
  user?: { userName?: string };
}
interface CcCredits {
  credits?: {
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
  };
}
interface CcSubscription {
  data?: {
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
    planId?: string;
  };
}
interface CcUsageSummary {
  totalCost?: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// "pro" -> "Pro", "PRO" -> "Pro", "individual-goat" -> "Individual Goat" - the
// API returns plan ids lowercase, sometimes hyphenated; the dashboard should
// read like a proper noun (glm.ts does the same for its plan levels).
function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// currentPeriodStart + one calendar month = when the monthly credit window
// refills. Fallback only: the subscriptions response carries a real
// currentPeriodEnd when available. Returns "" for an unparseable date so the
// caller can omit resetsAt.
function nextPeriod(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

const unavailable = (message: string): KeyUsageResult => ({
  windows: [],
  unavailable: true,
  message,
});

class CommandCodeAdapter extends OpenAICompatibleAdapter {
  supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return unavailable("Key disabled - usage not queried.");
    }

    // baseUrl is user-editable, so tolerate a trailing slash.
    const origin = ctx.baseUrl.replace(/\/+$/, "");
    const authHeaders = {
      authorization: `Bearer ${ctx.apiKey}`,
      accept: "application/json",
    };

    // All four calls share one failure contract: non-2xx -> HTTP <status>,
    // non-JSON body -> non-JSON, transport throw -> query failed.
    const getJson = async <T>(path: string): Promise<T> => {
      let res: AdapterHttpResponse;
      try {
        res = await ctx.request(origin + path, {
          method: "GET",
          headers: authHeaders,
          signal: ctx.signal,
        });
      } catch (err) {
        throw new Error(`Usage query failed: ${(err as Error).message}`);
      }
      if (!res.ok) {
        throw new Error(`Usage endpoint returned HTTP ${res.status}`);
      }
      try {
        return res.json() as T;
      } catch {
        throw new Error("Usage endpoint returned non-JSON.");
      }
    };

    try {
      // 1. whoami -> org id, when the key is org-scoped. Personal (user-scoped)
      //    keys return org: null and query the same endpoints WITHOUT orgId.
      const whoami = await getJson<CcWhoami>("/alpha/whoami");
      const orgId = whoami.org?.id;
      const orgParam = orgId
        ? `?orgId=${encodeURIComponent(orgId)}`
        : "";

      // 2. subscriptions -> billing period start + plan (summary needs `since`).
      const sub = await getJson<CcSubscription>(
        `/alpha/billing/subscriptions${orgParam}`,
      );
      const periodStart = sub.data?.currentPeriodStart ?? "";
      const periodEnd = sub.data?.currentPeriodEnd;
      const planId = sub.data?.planId ?? "";

      // 3. credits -> remaining monthly/purchased/free credit balances.
      const credits = await getJson<CcCredits>(
        `/alpha/billing/credits${orgParam}`,
      );
      const creditsObj = credits.credits;
      if (!creditsObj) {
        return unavailable("No credit data returned.");
      }
      const remaining =
        num(creditsObj.monthlyCredits) +
        num(creditsObj.purchasedCredits) +
        num(creditsObj.freeCredits);

      // 4. usage summary -> dollars spent since the period start.
      const summary = await getJson<CcUsageSummary>(
        `/alpha/usage/summary${orgParam}${orgParam ? "&" : "?"}since=${encodeURIComponent(periodStart)}`,
      );
      const spent = num(summary.totalCost);

      // Window: the cycle's total spend against the cycle's total credits
      // (spent + what's still in the monthly/purchased/free buckets).
      const limit = spent + remaining;
      if (limit <= 0) {
        return unavailable("No credit balance returned.");
      }
      // Prefer the upstream's own period end; fall back to start + 1 month.
      const resetsAt = periodEnd || nextPeriod(periodStart);
      const windows: ProviderKeyUsageWindow[] = [
        {
          id: "credits-cycle",
          label: "Credits (cycle)",
          used: spent,
          limit,
          unit: "dollars",
          ...(resetsAt ? { resetsAt } : {}),
        },
      ];
      const message = planId ? `Plan: ${titleCase(planId)}` : undefined;
      return { windows, ...(message ? { message } : {}) };
    } catch (err) {
      return unavailable((err as Error).message);
    }
  }
}

export const commandcode = new CommandCodeAdapter({
  id: "commandcode",
  label: "Command Code",
  blurb:
    "Every top model via Command Code's OpenAI/Anthropic-compatible Provider API.",
  brand: "commandcode",
  docsUrl: "https://commandcode.ai/docs/provider",
  defaults: {
    baseUrl: "https://api.commandcode.ai",
    basePath: "/provider/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "commandcode",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      required: true,
      hint: "Provider API key from Command Code Studio (same key as the CLI).",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://api.commandcode.ai",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
