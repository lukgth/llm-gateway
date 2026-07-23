import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isClaudeCodeUsageCreditsError,
  isClaudeCodeModelCreditsError,
  LONG_CONTEXT_USAGE_CREDITS_MESSAGE,
  MODEL_USAGE_CREDITS_MESSAGE,
} from "./usage-credits";

const body = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    message: LONG_CONTEXT_USAGE_CREDITS_MESSAGE,
  },
  request_id: "req_test",
});

function matches(
  overrides: Partial<Parameters<typeof isClaudeCodeUsageCreditsError>[0]> = {},
): boolean {
  return isClaudeCodeUsageCreditsError({
    status: 429,
    catalogId: "claude-code",
    upstreamModel: "claude-sonnet-4-6",
    body,
    ...overrides,
  });
}

test("matches the exact Claude Code Sonnet 4.6 long-context credits error", () => {
  assert.equal(matches(), true);
});

test("rejects other statuses and providers", () => {
  assert.equal(matches({ status: 400 }), false);
  assert.equal(matches({ catalogId: "anthropic" }), false);
});

test("is no longer model-gated — any Claude Code model with this 429 matches", () => {
  // The predicate used to require Sonnet 4.6; that gate was removed, so the
  // long-context credits 429 is now recognised for any Claude Code model.
  assert.equal(matches({ upstreamModel: "claude-opus-4-6" }), true);
  assert.equal(matches({ upstreamModel: "claude-sonnet-4-5" }), true);
});

test("rejects a non-rate-limit error type even with the credits message", () => {
  assert.equal(
    matches({
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: LONG_CONTEXT_USAGE_CREDITS_MESSAGE,
        },
      }),
    }),
    false,
  );
});

test("matches by substring — trailing wording and the 'Extra usage' variant", () => {
  // Detection is substring-based so a minor upstream tweak (extra trailing text,
  // or the older phrasing) still triggers the credit rotation.
  assert.equal(
    matches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: `${LONG_CONTEXT_USAGE_CREDITS_MESSAGE} Please upgrade.`,
        },
      }),
    }),
    true,
  );
  assert.equal(
    matches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: "Extra usage is required for long context requests.",
        },
      }),
    }),
    true,
  );
});

test("rejects an unrelated rate_limit_error message", () => {
  assert.equal(
    matches({
      body: JSON.stringify({
        error: { type: "rate_limit_error", message: "Too many requests." },
      }),
    }),
    false,
  );
});

test("rejects malformed or missing error bodies without throwing", () => {
  assert.equal(matches({ body: "not json" }), false);
  assert.equal(matches({ body: "{}" }), false);
});

// --- premium-model usage-credits 429 --------------------------------------

function modelMatches(
  overrides: Partial<Parameters<typeof isClaudeCodeModelCreditsError>[0]> = {},
): boolean {
  return isClaudeCodeModelCreditsError({
    status: 429,
    catalogId: "claude-code",
    upstreamModel: "claude-fable-5",
    body: JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: MODEL_USAGE_CREDITS_MESSAGE },
    }),
    ...overrides,
  });
}

test("matches the premium-model credits 429 by message", () => {
  assert.equal(modelMatches(), true);
});

test("matches the premium-model credits 429 by details.error_code", () => {
  // The real payload carries a structured code even when the message varies.
  assert.equal(
    modelMatches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: "Usage credits are required for this model.",
          details: {
            error_code: "credits_required",
            has_chargeable_saved_payment_method: false,
          },
        },
      }),
    }),
    true,
  );
});

test("model-credits and long-context detectors are mutually exclusive", () => {
  const longCtx = JSON.stringify({
    error: {
      type: "rate_limit_error",
      message: LONG_CONTEXT_USAGE_CREDITS_MESSAGE,
    },
  });
  // Long-context body: only the long-context detector fires.
  assert.equal(
    isClaudeCodeUsageCreditsError({
      status: 429,
      catalogId: "claude-code",
      upstreamModel: "claude-fable-5",
      body: longCtx,
    }),
    true,
  );
  assert.equal(
    isClaudeCodeModelCreditsError({
      status: 429,
      catalogId: "claude-code",
      upstreamModel: "claude-fable-5",
      body: longCtx,
    }),
    false,
  );
  // Model-credits body: only the model detector fires.
  assert.equal(modelMatches(), true);
  assert.equal(
    isClaudeCodeUsageCreditsError({
      status: 429,
      catalogId: "claude-code",
      upstreamModel: "claude-fable-5",
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: MODEL_USAGE_CREDITS_MESSAGE,
        },
      }),
    }),
    false,
  );
});

test("premium-model credits rejects other statuses/providers/types", () => {
  assert.equal(modelMatches({ status: 400 }), false);
  assert.equal(modelMatches({ catalogId: "anthropic" }), false);
  assert.equal(
    modelMatches({
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: MODEL_USAGE_CREDITS_MESSAGE,
        },
      }),
    }),
    false,
  );
  // An unrelated rate_limit_error (a real rate limit) must NOT match.
  assert.equal(
    modelMatches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: "This request would exceed your account's rate limit.",
        },
      }),
    }),
    false,
  );
});
