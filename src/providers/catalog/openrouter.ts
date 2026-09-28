import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// OpenRouter - aggregates many providers behind one OpenAI-compatible API.
// Note the /api path prefix in the base URL.
//
// Key usage: GET https://openrouter.ai/api/v1/key. Monetary fields are USD;
// `limit_reset` is a cadence (daily/weekly/monthly), not a reset timestamp.

interface OpenRouterKeyData {
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
  include_byok_in_limit?: boolean;
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  byok_usage?: number;
  byok_usage_daily?: number;
  byok_usage_weekly?: number;
  byok_usage_monthly?: number;
  is_free_tier?: boolean;
  expires_at?: string | number | null;
}

interface OpenRouterKeyResponse {
  data?: OpenRouterKeyData;
}

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function resetCadence(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reset = value.trim().toLowerCase();
  return reset || null;
}

interface OpenRouterCreditsData {
  total_credits?: number;
  total_usage?: number;
}

interface OpenRouterCreditsResponse {
  data?: OpenRouterCreditsData;
}

// Select the counter matching the key's reset cadence. OpenRouter reports BYOK
// separately, so include it only when the key says BYOK spend counts toward its
// limit. `limit_remaining`, when present, remains the authoritative source.
function fallbackUsage(
  data: OpenRouterKeyData,
  reset: string | null,
): number | null {
  let own: unknown;
  let byok: unknown;
  if (reset === "daily") {
    own = data.usage_daily;
    byok = data.byok_usage_daily;
  } else if (reset === "weekly") {
    own = data.usage_weekly;
    byok = data.byok_usage_weekly;
  } else if (reset === "monthly") {
    own = data.usage_monthly;
    byok = data.byok_usage_monthly;
  } else {
    own = data.usage;
    byok = data.byok_usage;
  }

  const used = amount(own);
  if (used === null) return null;
  if (data.include_byok_in_limit !== true) return used;
  const byokUsed = amount(byok) ?? 0;
  const total = used + byokUsed;
  return Number.isFinite(total) ? total : null;
}

function expiryIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;

  let ms: number;
  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))
  ) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
    ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  } else if (typeof value === "string") {
    ms = Date.parse(value);
  } else {
    return undefined;
  }

  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

class OpenRouterAdapter extends OpenAICompatibleAdapter {
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

    // Keep account-wide spend to explain a zero-balance result without drawing a 0/0 bar.
    let zeroBalanceUsage: number | null = null;

    try {
      const creditsRes = await ctx.request(ctx.resolve("/v1/credits"), {
        method: "GET",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          accept: "application/json",
        },
        signal: ctx.signal,
      });
      if (creditsRes.ok) {
        try {
          const credits = creditsRes.json() as OpenRouterCreditsResponse;
          const totalCredits = credits?.data?.total_credits;
          const totalUsage = credits?.data?.total_usage;
          if (
            typeof totalCredits === "number" &&
            Number.isFinite(totalCredits) &&
            typeof totalUsage === "number" &&
            Number.isFinite(totalUsage)
          ) {
            if (totalCredits > 0) {
              return {
                windows: [
                  {
                    id: "openrouter-balance",
                    label: "Balance",
                    used: Math.max(0, Math.min(totalUsage, totalCredits)),
                    limit: totalCredits,
                    unit: "dollars",
                  },
                ],
              };
            }
            if (totalCredits === 0) zeroBalanceUsage = Math.max(0, totalUsage);
          }
        } catch {
          // A credits response failure must not hide the existing key limit.
        }
      }
    } catch {
      // Fall through to the existing per-key spending-limit query.
    }

    let res;
    try {
      res = await ctx.request(ctx.resolve("/v1/key"), {
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

    let parsed: OpenRouterKeyResponse;
    try {
      parsed = res.json() as OpenRouterKeyResponse;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }

    const data = parsed?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned an unexpected response.",
      };
    }

    const reset = resetCadence(data.limit_reset);
    let used: number;
    let limit: number;
    let label: string;

    if (data.limit === null) {
      const allTimeUsage = fallbackUsage(data, null);
      if (allTimeUsage === null) {
        return {
          windows: [],
          unavailable: true,
          message: "Usage endpoint returned invalid usage data.",
        };
      }
      const expiresAt = expiryIso(data.expires_at);
      return {
        windows: [],
        message: zeroBalanceUsage === null
          ? `${data.is_free_tier === true ? "Free tier · " : ""}$${allTimeUsage.toFixed(2)} used all time · No key spending limit`
          : `${data.is_free_tier === true ? "Free tier · " : ""}$${zeroBalanceUsage.toFixed(2)} spent · $0.00 credit balance`,
        ...(expiresAt ? { expiresAt } : {}),
      };
    } else {
      const cappedLimit = amount(data.limit);
      if (cappedLimit === null) {
        return {
          windows: [],
          unavailable: true,
          message: "Usage endpoint returned an invalid credit limit.",
        };
      }
      limit = cappedLimit;
      if (cappedLimit === 0) {
        if (zeroBalanceUsage !== null) {
          const tier = data.is_free_tier === true ? "Free tier · " : "";
          const expiresAt = expiryIso(data.expires_at);
          return {
            windows: [],
            message: `${tier}$${zeroBalanceUsage.toFixed(2)} spent · $0.00 credit balance`,
            ...(expiresAt ? { expiresAt } : {}),
          };
        }
        return {
          windows: [],
          unavailable: true,
          message: "Key spending limit is zero.",
        };
      }

      const remaining = amount(data.limit_remaining);
      if (remaining !== null) {
        // Clamp inconsistent/negative upstream values into a valid progress-bar
        // range; exhausted keys remain visibly full rather than going negative.
        used = Math.max(0, limit - Math.min(remaining, limit));
      } else {
        const periodUsage = fallbackUsage(data, reset);
        if (periodUsage === null) {
          return {
            windows: [],
            unavailable: true,
            message: "Usage endpoint returned invalid usage data.",
          };
        }
        used = periodUsage;
      }
      label = reset ? `Spending limit (${reset})` : "Spending limit";
    }

    if (!Number.isFinite(limit)) {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned usage outside the supported range.",
      };
    }

    const expiresAt = expiryIso(data.expires_at);
    const message = data.is_free_tier === true ? "Free tier" : undefined;
    return {
      windows: [
        {
          id: "openrouter-credits",
          label,
          used,
          limit,
          unit: "dollars",
          // OpenRouter returns a reset cadence, not an absolute reset time, so
          // it cannot populate the shared window's ISO `resetsAt` field.
        },
      ],
      ...(expiresAt ? { expiresAt } : {}),
      ...(message ? { message } : {}),
    };
  }
}

export const openrouter = new OpenRouterAdapter({
  id: "openrouter",
  label: "OpenRouter",
  blurb: "Unified access to hundreds of models - OpenAI-compatible.",
  brand: "openrouter",
  docsUrl: "https://openrouter.ai/docs",
  defaults: {
    baseUrl: "https://openrouter.ai/api",
    endpoints: [WireKind.Chat, WireKind.Responses, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: true,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "openrouter", required: true },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-or-…",
      required: true,
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
