import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterUnifiedRateLimitHeaders,
  parseUnifiedRateLimitHeaders,
  unifiedRateLimitToUsageWindows,
  unifiedStatusMessage,
  filterStandardRateLimitHeaders,
  parseStandardRateLimitHeaders,
  standardRateLimitToUsageWindows,
} from "./unified-usage";

const HEADERS = {
  date: "Tue, 21 Jul 2026 01:58:48 GMT",
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1784607600",
  "anthropic-ratelimit-unified-5h-utilization": "0.05",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1785031200",
  "anthropic-ratelimit-unified-7d-utilization": "0.14",
  "anthropic-ratelimit-unified-7d_oi-status": "allowed",
  "anthropic-ratelimit-unified-7d_oi-reset": "1785031200",
  "anthropic-ratelimit-unified-7d_oi-utilization": "0.27",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-reset": "1784607600",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "request-id": "req_secret",
};

test("filters only unified rate-limit headers", () => {
  const filtered = filterUnifiedRateLimitHeaders(HEADERS);
  assert.equal(filtered.date, undefined);
  assert.equal(filtered["request-id"], undefined);
  assert.equal(filtered["anthropic-ratelimit-unified-status"], "allowed");
  assert.equal(Object.keys(filtered).length, 15);
});

test("parses supplied 5h, weekly, and 7d_oi windows", () => {
  const info = parseUnifiedRateLimitHeaders(HEADERS)!;
  assert.equal(info.status, "allowed");
  assert.equal(info.representativeWindowKey, "5h");
  assert.equal(info.fallbackPercentage, 0.5);
  assert.equal(info.resetsAt, new Date(1784607600 * 1000).toISOString());
  assert.deepEqual(
    info.windows.map((window) => [window.key, window.utilization]),
    [
      ["5h", 0.05],
      ["7d", 0.14],
      ["7d_oi", 0.27],
    ],
  );

  const windows = unifiedRateLimitToUsageWindows(info);
  assert.deepEqual(
    windows.map((window) => [window.id, window.label, window.used]),
    [
      ["unified-5h", "Prompts (5h)", 5],
      ["unified-7d", "Prompts (weekly)", 14],
      ["unified-7d_oi", "Prompts (Fable)", 27],
    ],
  );
  assert.ok(windows.every((window) => window.limit === 100));
});

test("discovers future windows and handles malformed values safely", () => {
  const info = parseUnifiedRateLimitHeaders({
    "anthropic-ratelimit-unified-future-status": "allowed_warning",
    "anthropic-ratelimit-unified-future-utilization": "1.4",
    "anthropic-ratelimit-unified-future-reset": "bad",
    "anthropic-ratelimit-unified-negative-status": "allowed",
    "anthropic-ratelimit-unified-negative-utilization": "-1",
  })!;
  const future = info.windows.find((window) => window.key === "future")!;
  assert.equal(future.utilization, 1);
  assert.equal(future.resetsAt, undefined);
  const negative = info.windows.find((window) => window.key === "negative")!;
  assert.equal(negative.utilization, undefined);
  assert.deepEqual(
    unifiedRateLimitToUsageWindows(info).map((window) => window.label),
    ["Window (future)", "Window (negative)"],
  );
});

test("accepts string-array values and representative reset fallback", () => {
  const info = parseUnifiedRateLimitHeaders({
    "anthropic-ratelimit-unified-status": ["allowed", "rejected"],
    "anthropic-ratelimit-unified-reset": "1784607600",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.1",
  })!;
  assert.equal(info.status, "allowed");
  assert.equal(
    unifiedRateLimitToUsageWindows(info)[0].resetsAt,
    new Date(1784607600 * 1000).toISOString(),
  );
});

test("status and overage messages are operator friendly", () => {
  assert.equal(
    unifiedStatusMessage({ status: "allowed_warning" }),
    "Approaching rate limit",
  );
  assert.equal(
    unifiedStatusMessage({
      status: "rejected",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
    }),
    "Rate limit exhausted · Overage rejected · org level disabled",
  );
});

test("no unified headers returns null and output is JSON finite", () => {
  assert.equal(parseUnifiedRateLimitHeaders({ date: "now" }), null);
  const windows = unifiedRateLimitToUsageWindows(
    parseUnifiedRateLimitHeaders(HEADERS)!,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(windows)), windows);
  assert.ok(windows.every((window) => Number.isFinite(window.used)));
});

// --- standard (non-unified) anthropic-ratelimit-* headers -------------------
// A plain pay-as-you-go Anthropic API key's response headers - see
// https://platform.claude.com/docs/en/api/rate-limits.

const STANDARD_HEADERS = {
  date: "Tue, 21 Jul 2026 01:58:48 GMT",
  "retry-after": "30",
  "anthropic-ratelimit-requests-limit": "1000",
  "anthropic-ratelimit-requests-remaining": "999",
  "anthropic-ratelimit-requests-reset": "2026-07-21T02:00:00Z",
  "anthropic-ratelimit-tokens-limit": "100000",
  "anthropic-ratelimit-tokens-remaining": "98000",
  "anthropic-ratelimit-tokens-reset": "2026-07-21T02:00:00Z",
  "anthropic-ratelimit-input-tokens-limit": "80000",
  "anthropic-ratelimit-input-tokens-remaining": "79000",
  "anthropic-ratelimit-input-tokens-reset": "2026-07-21T02:00:00Z",
  "anthropic-ratelimit-output-tokens-limit": "20000",
  "anthropic-ratelimit-output-tokens-remaining": "19000",
  "anthropic-ratelimit-output-tokens-reset": "2026-07-21T02:00:00Z",
  // Priority tier headers exist but aren't modeled - must be excluded, not
  // mistaken for a "priority" bucket.
  "anthropic-priority-input-tokens-limit": "5000",
  "anthropic-priority-input-tokens-remaining": "4000",
  "request-id": "req_secret",
};

test("filterStandardRateLimitHeaders keeps only the standard buckets", () => {
  const filtered = filterStandardRateLimitHeaders(STANDARD_HEADERS);
  assert.equal(filtered.date, undefined);
  assert.equal(filtered["retry-after"], undefined);
  assert.equal(filtered["request-id"], undefined);
  assert.equal(filtered["anthropic-priority-input-tokens-limit"], undefined);
  assert.equal(filtered["anthropic-ratelimit-requests-limit"], "1000");
  assert.equal(Object.keys(filtered).length, 12);
});

test("filterStandardRateLimitHeaders excludes the unified-* family", () => {
  const filtered = filterStandardRateLimitHeaders(HEADERS);
  assert.deepEqual(filtered, {});
});

test("parseStandardRateLimitHeaders parses all four buckets", () => {
  const windows = parseStandardRateLimitHeaders(STANDARD_HEADERS);
  assert.equal(windows.length, 4);
  const byBucket = Object.fromEntries(windows.map((w) => [w.bucket, w]));
  assert.equal(byBucket.requests.limit, 1000);
  assert.equal(byBucket.requests.remaining, 999);
  assert.equal(
    byBucket.requests.resetsAt,
    new Date("2026-07-21T02:00:00Z").toISOString(),
  );
  assert.equal(byBucket.tokens.limit, 100000);
  assert.equal(byBucket["input-tokens"].limit, 80000);
  assert.equal(byBucket["output-tokens"].limit, 20000);
});

test("parseStandardRateLimitHeaders only reports buckets actually present", () => {
  const windows = parseStandardRateLimitHeaders({
    "anthropic-ratelimit-requests-limit": "1000",
    "anthropic-ratelimit-requests-remaining": "999",
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].bucket, "requests");
});

test("parseStandardRateLimitHeaders returns [] when nothing is present", () => {
  assert.deepEqual(parseStandardRateLimitHeaders({ date: "now" }), []);
  assert.deepEqual(parseStandardRateLimitHeaders(undefined), []);
});

test("standardRateLimitToUsageWindows converts remaining/limit to used/limit", () => {
  const windows = standardRateLimitToUsageWindows(
    parseStandardRateLimitHeaders(STANDARD_HEADERS),
  );
  const byId = Object.fromEntries(windows.map((w) => [w.id, w]));
  assert.equal(byId["standard-requests"].used, 1); // 1000 - 999
  assert.equal(byId["standard-requests"].limit, 1000);
  assert.equal(byId["standard-requests"].unit, "requests");
  assert.equal(byId["standard-tokens"].used, 2000); // 100000 - 98000
  assert.equal(byId["standard-tokens"].unit, "tokens");
  assert.equal(
    byId["standard-input-tokens"].resetsAt,
    new Date("2026-07-21T02:00:00Z").toISOString(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(windows)), windows);
});

test("standardRateLimitToUsageWindows drops a bucket missing limit or remaining", () => {
  const windows = standardRateLimitToUsageWindows([
    { bucket: "requests", limit: 1000 }, // no remaining
    { bucket: "tokens", remaining: 500 }, // no limit
  ]);
  assert.equal(windows.length, 0);
});
