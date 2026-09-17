import {
  OpenAICompatibleAdapter,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind } from "../../types";
import type { ProviderKeyUsageWindow } from "../../types";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

class OllamaLocalAdapter extends OpenAICompatibleAdapter {}

// Ollama Cloud usage envelope from GET /api/usage. The endpoint is
// undocumented and has flipped shapes over time: legacy plans report `session`
// (5h) + `weekly` (7d) buckets, while newer credits-based plans report a single
// `monthly` bucket. It has served monthly-only, both legacy buckets, or a mix,
// so every bucket is optional and whichever are present are reported.
// Each `usage` is a consumed fraction [0,1] of that bucket's own cap, not a
// wall-clock timestamp. The endpoint carries no reset timestamps: only the 5h
// / 7d cadences are known (with community-observed anchor grids), and the
// monthly reset day is tied to the account's signup date, which is not exposed,
// so the monthly window omits `resetsAt` and all windows render as
// percent-consumed rather than layering session on top of weekly.
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
    monthly?: OllamaUsageLimit;
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// /api/usage returns no reset timestamps, only cadences (session 5h, weekly 7d).
// The anchors below are the community-observed convention: the 5-hour session
// clock rides the Unix-epoch grid, while the weekly clock resets Monday 00:00
// UTC. Always UTC (DST-free).

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

// Next session reset: the next 5-hour tick strictly after `ms`, on a fixed
// grid measured from the Unix epoch (1970-01-01T00:00:00Z), NOT from Monday
// 00:00 UTC - the two grids differ because a week (168h) is not a whole number
// of 5h sessions. Community observation (ollama/ollama#12532) confirms
// reset_in = 18000 - epoch%18000.
export function ollamaNextSessionReset(ms: number): number {
  const periodMs = 5 * HOUR_MS;
  return (Math.floor(ms / periodMs) + 1) * periodMs;
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
    // Monthly has no exposed reset day (tied to the account's signup date), so
    // it carries no resetsAt - the endpoint exposes no timestamp for it.
    const monthly = ratio(limits.monthly);
    if (monthly !== null) {
      windows.push({
        id: "monthly",
        label: "Monthly usage",
        used: monthly,
        limit: 100,
        unit: "percent",
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
