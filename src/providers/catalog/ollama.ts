import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

class OllamaLocalAdapter extends OpenAICompatibleAdapter {}

// Ollama Cloud usage envelope from GET /api/usage:
//   {
//     "activity": {
//       "cost": "0.00000",
//       "period": { "type": "last_4_weeks" }
//     },
//     "limits": {
//       "session": { "usage": 0.122 },  // fractional [0,1] of a 5-hour window
//       "weekly":  { "usage": 0.045 }   // fractional [0,1] of a 7-day window
//     }
//   }
// Each usage entry is an independent consumed fraction of its own window, NOT a
// wall-clock timestamp - Ollama's pricing FAQ defines only a cadence ("reset
// every 5 hours" / "every 7 days") and never publishes a shared reset anchor.
// The `/api/usage` shape carries no reset timestamp, so `resetsAt` is omitted
// and both windows render as percent-consumed rather than layering session on
// top of weekly.
interface OllamaUsagePeriod {
  type?: string;
}
interface OllamaUsageActivity {
  cost?: unknown;
  period?: OllamaUsagePeriod;
}
interface OllamaUsageLimit {
  usage?: unknown;
}
interface OllamaUsageResponse {
  activity?: OllamaUsageActivity;
  limits?: {
    session?: OllamaUsageLimit;
    weekly?: OllamaUsageLimit;
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// /api/usage returns no reset timestamps, only cadences (session 5h, weekly 7d).
// The anchors below are the operator-observed convention: weekly resets Monday
// 00:00 UTC, and the 5-hour session clock is anchored at the same Monday 00:00,
// so a session reset is a multiple of 5h from that point. Always UTC (DST-free).

// Monday 00:00:00.000Z of the UTC week containing `ms`.
export function ollamaWeeklyResetAnchor(ms: number): number {
  const monday = new Date(ms);
  monday.setUTCHours(0, 0, 0, 0);
  const back = (monday.getUTCDay() + 6) % 7; // days since Monday
  monday.setUTCDate(monday.getUTCDate() - back);
  return monday.getTime();
}

// Next weekly reset: the next Monday 00:00 UTC strictly after `ms`.
export function ollamaNextWeeklyReset(ms: number): number {
  return ollamaWeeklyResetAnchor(ms) + 7 * DAY_MS;
}

// Next session reset: the next 5-hour tick strictly after `ms`, on a grid
// anchored at Monday 00:00 UTC (a reset lands at the anchor, then every 5h).
// Snaps `ms` up to the next grid multiple of 5h past the anchor, excluding the
// exact-anchor instant itself. The 5h grid is independent of the weekly clock:
// it never accumulates on top of the weekly window.
export function ollamaNextSessionReset(ms: number): number {
  const anchor = ollamaWeeklyResetAnchor(ms);
  const periodMs = 5 * HOUR_MS;
  const elapsed = ms - anchor;
  return anchor + (Math.floor(elapsed / periodMs) + 1) * periodMs;
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

    let res;
    try {
      res = await ctx.request(ctx.resolve("/api/usage"), {
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

    let parsed: OllamaUsageResponse;
    try {
      parsed = res.json() as OllamaUsageResponse;
    } catch {
      return {
        windows: [],
        unavailable: true,
        message: "Usage endpoint returned a non-JSON response.",
      };
    }

    const limits = parsed?.limits;
    const activity = parsed?.activity;
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse quota data.",
      };
    }

    // A valid usage entry is a finite fraction in [0,1]; an invalid entry is
    // skipped independently rather than failing the other window.
    const ratio = (entry: OllamaUsageLimit | undefined): number | null => {
      const value = entry?.usage;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      ) {
        return null;
      }
      return value * 100;
    };

    const now = Date.now();
    const windows: ProviderKeyUsageWindow[] = [];
    const session = ratio(limits.session);
    if (session !== null) {
      windows.push({
        id: "session",
        label: "5-hour usage",
        used: session,
        limit: 100,
        unit: "percent",
        resetsAt: new Date(ollamaNextSessionReset(now)).toISOString(),
      });
    }
    const weekly = ratio(limits.weekly);
    if (weekly !== null) {
      windows.push({
        id: "weekly",
        label: "Weekly usage",
        used: weekly,
        limit: 100,
        unit: "percent",
        resetsAt: new Date(ollamaNextWeeklyReset(now)).toISOString(),
      });
    }

    if (windows.length === 0) {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse quota data.",
      };
    }

    const result: KeyUsageResult = { windows };

    // Attach the 4-week cost when valid activity exists. The upstream sends a
    // lossy string like "0.00000"; parse it and render clean currency ($0.00)
    // rather than echoing the raw digits.
    const hasCost =
      activity &&
      typeof activity === "object" &&
      !Array.isArray(activity) &&
      typeof activity.cost === "string" &&
      activity.period?.type === "last_4_weeks";
    if (hasCost) {
      const cost = Number(activity.cost);
      result.message =
        Number.isFinite(cost)
          ? `Last 4 weeks cost: $${cost.toFixed(2)}`
          : `Last 4 weeks cost: $${activity.cost}`;
    }

    return result;
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
