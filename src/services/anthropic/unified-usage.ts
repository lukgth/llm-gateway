import type { ProviderKeyUsageWindow } from "../../types";

export type HeaderTable = Record<string, string | string[] | undefined>;

export interface UnifiedRateLimitWindow {
  key: string;
  status?: string;
  utilization?: number;
  resetsAt?: string;
}

export interface UnifiedRateLimitInfo {
  status?: string;
  resetsAt?: string;
  representativeClaim?: string;
  representativeWindowKey?: string;
  fallbackPercentage?: number;
  overageStatus?: string;
  overageDisabledReason?: string;
  windows: UnifiedRateLimitWindow[];
}

const PREFIX = "anthropic-ratelimit-unified-";
const WINDOW_RE =
  /^anthropic-ratelimit-unified-(.+)-(status|reset|utilization)$/;
const RESERVED = new Set([
  "representative-claim",
  "fallback-percentage",
  // `overage-status` matches the dynamic-window regex as key="overage",
  // field="status"; reserve the captured key so it stays top-level metadata.
  "overage",
  "overage-disabled-reason",
]);

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fraction(value: string | undefined): number | undefined {
  const parsed = number(value);
  if (parsed === undefined || parsed < 0) return undefined;
  return Math.min(1, parsed);
}

function epochIso(value: string | undefined): string | undefined {
  const parsed = number(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  const iso = new Date(parsed * 1000).toISOString();
  return iso;
}

export function filterUnifiedRateLimitHeaders(
  headers: HeaderTable | undefined,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  if (!headers) return filtered;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!name.startsWith(PREFIX)) continue;
    const value = first(rawValue);
    if (value !== undefined) filtered[name] = value;
  }
  return filtered;
}

export function parseUnifiedRateLimitHeaders(
  headers: HeaderTable | undefined,
): UnifiedRateLimitInfo | null {
  const normalized = filterUnifiedRateLimitHeaders(headers);
  const names = Object.keys(normalized);
  if (!names.length) return null;

  const windows = new Map<string, UnifiedRateLimitWindow>();
  for (const name of names) {
    const match = WINDOW_RE.exec(name);
    if (!match) continue;
    const [, key, field] = match;
    if (RESERVED.has(key)) continue;
    const window = windows.get(key) ?? { key };
    const value = normalized[name];
    if (field === "status") window.status = value;
    else if (field === "utilization") window.utilization = fraction(value);
    else if (field === "reset") window.resetsAt = epochIso(value);
    windows.set(key, window);
  }

  const representativeClaim = normalized[`${PREFIX}representative-claim`];
  const representativeWindowKey =
    representativeClaim === "five_hour"
      ? "5h"
      : representativeClaim === "seven_day"
        ? "7d"
        : representativeClaim;

  const order = (key: string): number =>
    key === "5h" ? 0 : key === "7d" ? 1 : key === "7d_oi" ? 2 : 3;

  return {
    status: normalized[`${PREFIX}status`],
    resetsAt: epochIso(normalized[`${PREFIX}reset`]),
    representativeClaim,
    representativeWindowKey,
    fallbackPercentage: number(normalized[`${PREFIX}fallback-percentage`]),
    overageStatus: normalized[`${PREFIX}overage-status`],
    overageDisabledReason: normalized[`${PREFIX}overage-disabled-reason`],
    windows: [...windows.values()].sort(
      (a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key),
    ),
  };
}

// --- standard (non-unified) anthropic-ratelimit-* headers -------------------
//
// Every plain Anthropic API response (any key, not just Claude Code
// subscription auth) carries these on every request, per
// https://platform.claude.com/docs/en/api/rate-limits: the requests/tokens
// limit for the current window, plus separate input/output token buckets.
// Distinct from (and simpler than) the "unified" scheme above, which is
// specific to Claude Code's subscription billing - a plain pay-as-you-go key
// never sends anthropic-ratelimit-unified-* at all, only these.

const STANDARD_PREFIX = "anthropic-ratelimit-";
const STANDARD_BUCKETS = [
  "requests",
  "tokens",
  "input-tokens",
  "output-tokens",
] as const;
type StandardBucket = (typeof STANDARD_BUCKETS)[number];

export interface StandardRateLimitWindow {
  bucket: StandardBucket;
  limit?: number;
  remaining?: number;
  /** ISO timestamp - the header is RFC 3339, already ISO-compatible. */
  resetsAt?: string;
}

export function filterStandardRateLimitHeaders(
  headers: HeaderTable | undefined,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  if (!headers) return filtered;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    // Excludes the unified-* and priority-* families explicitly - both start
    // with "anthropic-ratelimit-" too but are parsed by their own logic
    // (unified above) or aren't modeled at all (priority tier, rare).
    if (
      !name.startsWith(STANDARD_PREFIX) ||
      name.startsWith(`${STANDARD_PREFIX}unified-`) ||
      name.startsWith("anthropic-priority-")
    )
      continue;
    const value = first(rawValue);
    if (value !== undefined) filtered[name] = value;
  }
  return filtered;
}

function parseIsoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

// Parses the standard bucket headers into one entry per bucket that's
// actually present (a request-only response, for instance, has no
// input/output-tokens headers at all - only Anthropic's own request mix
// decides which buckets appear). Returns [] when none are present.
export function parseStandardRateLimitHeaders(
  headers: HeaderTable | undefined,
): StandardRateLimitWindow[] {
  const normalized = filterStandardRateLimitHeaders(headers);
  const out: StandardRateLimitWindow[] = [];
  for (const bucket of STANDARD_BUCKETS) {
    const limit = number(normalized[`${STANDARD_PREFIX}${bucket}-limit`]);
    const remaining = number(normalized[`${STANDARD_PREFIX}${bucket}-remaining`]);
    const resetsAt = parseIsoOrUndefined(
      normalized[`${STANDARD_PREFIX}${bucket}-reset`],
    );
    if (limit === undefined && remaining === undefined && resetsAt === undefined)
      continue;
    out.push({ bucket, limit, remaining, resetsAt });
  }
  return out;
}

const STANDARD_BUCKET_LABELS: Record<StandardBucket, string> = {
  requests: "Requests (per-minute)",
  tokens: "Tokens (most restrictive)",
  "input-tokens": "Input tokens",
  "output-tokens": "Output tokens",
};

// Standard windows report REMAINING/LIMIT (a countdown), the inverse of the
// unified scheme's used-percentage - convert to the same used/limit/percent
// convention every other ProviderKeyUsageWindow uses for display parity.
export function standardRateLimitToUsageWindows(
  windows: StandardRateLimitWindow[],
): ProviderKeyUsageWindow[] {
  return windows
    .filter((w) => w.limit !== undefined && w.remaining !== undefined)
    .map((w) => ({
      id: `standard-${w.bucket}`,
      label: STANDARD_BUCKET_LABELS[w.bucket],
      used: w.limit! - w.remaining!,
      limit: w.limit!,
      unit: w.bucket === "requests" ? "requests" : "tokens",
      ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
    }));
}

function windowLabel(key: string): string {
  if (key === "5h") return "Prompts (5h)";
  if (key === "7d") return "Prompts (weekly)";
  if (key === "7d_oi") return "Prompts (Fable)";
  return `Window (${key})`;
}

export function unifiedRateLimitToUsageWindows(
  info: UnifiedRateLimitInfo,
): ProviderKeyUsageWindow[] {
  return info.windows.flatMap((window) => {
    if (window.status === undefined && window.utilization === undefined)
      return [];
    const resetsAt =
      window.resetsAt ??
      (window.key === info.representativeWindowKey ? info.resetsAt : undefined);
    return [
      {
        id: `unified-${window.key}`,
        label: windowLabel(window.key),
        used: Math.round((window.utilization ?? 0) * 100),
        limit: 100,
        unit: "percent" as const,
        ...(resetsAt ? { resetsAt } : {}),
      },
    ];
  });
}

export function unifiedStatusMessage(
  info: Pick<
    UnifiedRateLimitInfo,
    "status" | "overageStatus" | "overageDisabledReason"
  >,
): string | undefined {
  const messages: Record<string, string | undefined> = {
    allowed: undefined,
    allowed_warning: "Approaching rate limit",
    rejected: "Rate limit exhausted",
    rate_limited: "Rate limited",
    blocked: "Blocked by upstream",
    queueing_hard: "Requests queued (hard limit)",
    queueing_soft: "Requests queued",
    payment_required: "Payment required",
  };
  const parts = [messages[info.status ?? ""]].filter(Boolean) as string[];
  if (info.overageStatus && info.overageStatus !== "allowed")
    parts.push(`Overage ${info.overageStatus.replaceAll("_", " ")}`);
  if (info.overageDisabledReason)
    parts.push(info.overageDisabledReason.replaceAll("_", " "));
  return parts.length ? parts.join(" · ") : undefined;
}
