import {
  parseUnifiedRateLimitHeaders,
  type UnifiedRateLimitWindow,
} from "./unified-usage";

// Classifies a Claude Code (subscription) 429 by WHICH unified quota window is
// exhausted — the base 5h/7d windows (shared by every model) vs the Fable/Mythos
// 7d_oi window (premium-only). The split matters because the two recover on very
// different clocks: base on a ~hourly/weekly cycle, 7d_oi over days. Treating a
// 7d_oi exhaustion as a GLOBAL rate limit (and inheriting its multi-day reset)
// would wrongly lock a key out of base models — Opus/Sonnet/Haiku — for days,
// even though its base quota frees up in minutes. So:
//   - base exhausted            -> "global", reset from the BASE windows only
//                                   (never 7d_oi), + a separate Fable reset when
//                                   7d_oi is ALSO maxed so premium stays blocked;
//   - only 7d_oi exhausted      -> "model" (fable), reset from 7d_oi;
//   - nothing provably exhausted -> "global" with no reset (caller falls back to
//                                   Retry-After / default).
// Classification is header-driven, NOT keyed on the requested model: the windows
// say what's actually limited, so a stray non-Fable request that somehow returns
// a 7d_oi-only 429 still cools only the Fable class, leaving base usable.

export type RateLimitScope =
  | {
      scope: "global";
      reason: string;
      /** Epoch ms when the BASE (5h/7d) quota recovers — from base windows
       *  ONLY, never 7d_oi, so a maxed Fable window can't inflate the base
       *  cooldown. Undefined when no exhausted base window carried a usable
       *  reset (caller falls back to Retry-After / default). */
      baseResetAt?: number;
      /** Epoch ms when Fable (7d_oi) recovers, when it is ALSO exhausted in
       *  this same 429 — the caller layers a separate Fable model-cooldown on
       *  top of the (shorter) base rate limit so premium stays blocked to its
       *  own reset. */
      fableResetAt?: number;
    }
  | {
      scope: "model";
      modelClass: "fable";
      resetAt: number;
      reason: string;
    };

const EXHAUSTED_STATUSES = new Set(["rejected", "blocked", "rate_limited"]);

function exhausted(window: UnifiedRateLimitWindow | undefined): boolean {
  if (!window) return false;
  if (window.status !== undefined)
    return EXHAUSTED_STATUSES.has(window.status.toLowerCase());
  return window.utilization !== undefined && window.utilization >= 1;
}

// A window's own reset epoch (ms), when it parses to a real future instant.
function resetEpoch(
  window: UnifiedRateLimitWindow | undefined,
  now: number,
): number | null {
  const iso = window?.resetsAt;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > now ? ms : null;
}

export function classifyAnthropicRateLimit(
  input: {
    status: number;
    catalogId: string | null | undefined;
    // Retained for call-site compatibility/logging; classification is
    // header-driven and does NOT gate on the requested model (see file header).
    upstreamModel: string;
    headers: Record<string, string | string[] | undefined>;
  },
  now = Date.now(),
): RateLimitScope {
  const global = (
    reason: string,
    extra: { baseResetAt?: number; fableResetAt?: number } = {},
  ): RateLimitScope => ({ scope: "global", reason, ...extra });

  if (input.status !== 429) return global("not an HTTP 429");
  if (input.catalogId !== "claude-code")
    return global("provider is not Claude Code");

  const info = parseUnifiedRateLimitHeaders(input.headers);
  if (!info) return global("unified quota headers missing");
  const windows = new Map(info.windows.map((w) => [w.key, w]));
  const fable = windows.get("7d_oi");
  const fiveHour = windows.get("5h");
  const weekly = windows.get("7d");

  const fableExhausted = exhausted(fable);
  const baseExhausted = exhausted(fiveHour) || exhausted(weekly);

  // Fable recovery: 7d_oi's own reset, else the representative reset, else a
  // short default so a missing header can't wedge the class open indefinitely.
  const fableResetIso = fable?.resetsAt ?? info.resetsAt;
  const fableResetParsed = fableResetIso
    ? Date.parse(fableResetIso)
    : Number.NaN;
  const fableResetAt =
    Number.isFinite(fableResetParsed) && fableResetParsed > now
      ? fableResetParsed
      : now + 60_000;

  if (baseExhausted) {
    // BASE recovery = latest reset among the base windows that are actually
    // exhausted. 7d_oi is deliberately excluded so a maxed Fable window never
    // extends the base cooldown.
    const baseResets = [
      exhausted(fiveHour) ? resetEpoch(fiveHour, now) : null,
      exhausted(weekly) ? resetEpoch(weekly, now) : null,
    ].filter((r): r is number => r !== null);
    const baseResetAt = baseResets.length ? Math.max(...baseResets) : undefined;
    return global(
      fableExhausted
        ? "base 5h/7d quota exhausted (Fable 7d_oi also exhausted — separate cooldown)"
        : "base 5h/7d quota exhausted",
      {
        ...(baseResetAt !== undefined ? { baseResetAt } : {}),
        ...(fableExhausted ? { fableResetAt } : {}),
      },
    );
  }

  if (fableExhausted) {
    // Only the premium window is maxed — cool the Fable class alone; base
    // (Opus/Sonnet/Haiku) stays fully usable on this key.
    return {
      scope: "model",
      modelClass: "fable",
      resetAt: fableResetAt,
      reason: "Fable 7d_oi exhausted while base 5h/7d quota remains available",
    };
  }

  // Neither base nor Fable is provably exhausted (ambiguous / generic 429) —
  // stay global with no reset; the caller falls back to Retry-After / default.
  return global("no unified window is exhausted (generic 429)");
}
