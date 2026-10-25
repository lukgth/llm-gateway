import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

class OllamaLocalAdapter extends OpenAICompatibleAdapter {}

// Ollama Cloud reports a key's standing through two documented endpoints:
//   GET /api/balance - the live quota. `included` is either credits
//     ({ balance_usd, allowance_usd, period }) or, on legacy plans, per-window
//     limits ({ session, weekly } of { remaining_percent, resets_at });
//     `purchased` is the unexpired prepaid credit balance (one-shot - it never
//     refills). Both included shapes carry their own reset timestamps, so no
//     cadence is guessed here.
//   GET /api/usage?range=24h - recorded spend (request/token/USD totals) over
//     the trailing 24 hours.
// Balance is authoritative for the bars; usage totals only annotate the card's
// message line. Every field is optional on the wire, so each is validated on
// its own and a malformed one is skipped rather than failing the whole key.
interface OllamaBalancePeriod {
  from?: unknown;
  until?: unknown;
}
interface OllamaLegacyLimit {
  remaining_percent?: unknown;
  resets_at?: unknown;
}
interface OllamaBalanceResponse {
  included?: {
    balance_usd?: unknown;
    allowance_usd?: unknown;
    period?: OllamaBalancePeriod;
    session?: OllamaLegacyLimit;
    weekly?: OllamaLegacyLimit;
  };
  purchased?: { balance_usd?: unknown };
}
interface OllamaUsageTotals {
  request_count?: unknown;
  usage_usd?: unknown;
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
}
interface OllamaUsageResponse {
  totals?: OllamaUsageTotals;
}

// A non-negative finite number, or null when the field is absent/malformed.
function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

// An ISO timestamp from an upstream date string, or undefined if unparseable.
function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// Compact counts for the message line: 999, 12.4k, 1.2M.
function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// USD, keeping sub-cent spend readable ($0.0004) instead of rounding it to $0.00.
function usd(n: number): string {
  if (n === 0) return "$0.00";
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

class OllamaCloudAdapter extends OpenAICompatibleAdapter {
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

    const authHeaders = {
      authorization: `Bearer ${ctx.apiKey}`,
      accept: "application/json",
    };

    let res;
    try {
      res = await ctx.request(ctx.resolve("/api/balance"), {
        method: "GET",
        headers: authHeaders,
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

    let parsed: OllamaBalanceResponse;
    try {
      parsed = res.json() as OllamaBalanceResponse;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }

    const included = parsed?.included;
    const quota =
      included && typeof included === "object" && !Array.isArray(included)
        ? included
        : null;

    const windows: ProviderKeyUsageWindow[] = [];

    // Legacy plans report what REMAINS per window, so used = 100 - remaining.
    // `resets_at` is the upstream's own timestamp - no cadence guessing.
    const percentWindow = (
      id: string,
      label: string,
      entry: OllamaLegacyLimit | undefined,
    ): void => {
      const remaining = nonNegative(entry?.remaining_percent);
      if (remaining === null || remaining > 100) return;
      const resetsAt = isoTime(entry?.resets_at);
      windows.push({
        id,
        label,
        used: 100 - remaining,
        limit: 100,
        unit: "percent",
        ...(resetsAt ? { resetsAt } : {}),
      });
    };
    percentWindow("session", "5-hour usage", quota?.session);
    percentWindow("weekly", "Weekly usage", quota?.weekly);

    // Credits plans: included allowance consumed against the period's cap. The
    // period carries the real reset time, so this bar is exact.
    const remainingUsd = nonNegative(quota?.balance_usd);
    const allowanceUsd = nonNegative(quota?.allowance_usd);
    if (remainingUsd !== null && allowanceUsd !== null && allowanceUsd > 0) {
      const resetsAt = isoTime(quota?.period?.until);
      windows.push({
        id: "included",
        label: "Included credits",
        // Round away float subtraction noise (2.5 - 2.49657 = 0.003430000000000822).
        used:
          Math.round(
            Math.min(allowanceUsd, Math.max(0, allowanceUsd - remainingUsd)) *
              1e6,
          ) / 1e6,
        limit: allowanceUsd,
        unit: "dollars",
        ...(resetsAt ? { resetsAt } : {}),
      });
    }

    // Spend totals are decoration for the message line: a failing /api/usage
    // must not blank the quota bars the balance just produced.
    let totals: OllamaUsageTotals | null = null;
    try {
      const usageRes = await ctx.request(ctx.resolve("/api/usage?range=24h"), {
        method: "GET",
        headers: authHeaders,
        signal: ctx.signal,
      });
      if (usageRes.ok) {
        const body = usageRes.json() as OllamaUsageResponse;
        const t = body?.totals;
        if (t && typeof t === "object" && !Array.isArray(t)) totals = t;
      }
    } catch {
      totals = null;
    }

    const notes: string[] = [];
    if (totals) {
      const requests = nonNegative(totals.request_count);
      const spent = nonNegative(totals.usage_usd);
      const input = nonNegative(totals.input_tokens);
      const cached = nonNegative(totals.cached_input_tokens);
      const output = nonNegative(totals.output_tokens);
      const bits: string[] = [];
      if (requests !== null) {
        bits.push(
          `${compactCount(requests)} request${requests === 1 ? "" : "s"}`,
        );
      }
      if (spent !== null) bits.push(usd(spent));
      if (input !== null && output !== null && input + output > 0) {
        const cachedNote =
          cached !== null && cached > 0
            ? ` (${compactCount(cached)} cached)`
            : "";
        bits.push(
          `${compactCount(input)} in${cachedNote} / ${compactCount(output)} out`,
        );
      }
      if (bits.length > 0) notes.push(`24h: ${bits.join(" · ")}`);
    }
    // Purchased credits are a one-shot balance with no cap to fill, so they
    // belong in the note rather than as a 0/0 bar.
    const purchasedUsd = nonNegative(parsed?.purchased?.balance_usd);
    if (purchasedUsd !== null && purchasedUsd > 0) {
      notes.push(`Purchased credits: ${usd(purchasedUsd)}`);
    }
    const message = notes.length > 0 ? notes.join(" · ") : undefined;

    if (windows.length === 0 && !message) {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse quota data.",
      };
    }

    return { windows, ...(message ? { message } : {}) };
  }
}

// Ollama (local) - self-hosted Ollama instance, OpenAI-compatible.
export const ollama = new OllamaLocalAdapter({
  id: "ollama",
  label: "Ollama",
  blurb: "Self-hosted Ollama instance - local open-weight models.",
  brand: "ollama",
  defaults: {
    baseUrl: "http://localhost:11434",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    { key: "name", label: "Name", placeholder: "ollama", required: true },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "http://localhost:11434",
      required: true,
      editable: true,
      hint: "Your Ollama instance origin - the gateway appends /v1/chat/completions.",
    },
    {
      key: "apiKeys",
      label: "API key",
      hint: "Usually not needed for local Ollama.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});

// Ollama Cloud - hosted Ollama API.
export const ollamaCloud = new OllamaCloudAdapter({
  id: "ollama-cloud",
  label: "Ollama Cloud",
  blurb: "Ollama Cloud - hosted open models via the OpenAI-compatible API.",
  brand: "ollama",
  defaults: {
    baseUrl: "https://ollama.com",
    endpoints: [WireKind.Chat],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "ollama-cloud",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "ollama-…",
      required: true,
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
