import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isClaudeCodeUsageCreditsError,
  isClaudeCodeModelCreditsError,
  isAnthropicCreditBalanceError,
  isAnthropicAccountAuthError,
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

test("is no longer model-gated - any Claude Code model with this 429 matches", () => {
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

test("matches by substring - trailing wording and the 'Extra usage' variant", () => {
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

function creditBalanceMatches(
  overrides: Partial<Parameters<typeof isAnthropicCreditBalanceError>[0]> = {},
): boolean {
  return isAnthropicCreditBalanceError({
    status: 400,
    catalogId: "anthropic",
    body: JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    }),
    ...overrides,
  });
}

test("matches the Anthropic credit-balance-too-low 400", () => {
  assert.equal(creditBalanceMatches(), true);
});

test("credit-balance rejects other statuses/providers/types", () => {
  assert.equal(creditBalanceMatches({ status: 429 }), false);
  assert.equal(creditBalanceMatches({ catalogId: "claude-code" }), false);
  assert.equal(creditBalanceMatches({ catalogId: null }), false);
  assert.equal(
    creditBalanceMatches({
      body: JSON.stringify({
        error: {
          type: "rate_limit_error",
          message:
            "Your credit balance is too low to access the Anthropic API.",
        },
      }),
    }),
    false,
  );
  assert.equal(
    creditBalanceMatches({
      body: JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "model: field required",
        },
      }),
    }),
    false,
  );
  assert.equal(creditBalanceMatches({ body: "not json" }), false);
});

test("credit-balance ALSO matches a non-'anthropic' catalog speaking the messages providerFmt", () => {
  // A differently-named Anthropic-compatible catalog entry (or a generic
  // template pointed at an Anthropic-compatible backend) must rotate on the
  // identical body instead of hard-failing just because its catalogId isn't
  // literally "anthropic".
  assert.equal(
    creditBalanceMatches({
      catalogId: "my-anthropic-proxy",
      providerFmt: "messages",
    }),
    true,
  );
  // Without providerFmt supplied at all, the old catalogId-only gate still
  // applies (existing callers that haven't been updated keep working as before).
  assert.equal(
    creditBalanceMatches({ catalogId: "my-anthropic-proxy" }),
    false,
  );
  // A non-messages-format provider never matches even if somehow mislabeled.
  assert.equal(
    creditBalanceMatches({ catalogId: "openai", providerFmt: "chat" }),
    false,
  );
});

// --- account auth error (400 posing as 401/403) ---------------------------

function accountAuthMatches(
  overrides: Partial<Parameters<typeof isAnthropicAccountAuthError>[0]> = {},
): boolean {
  return isAnthropicAccountAuthError({
    status: 400,
    catalogId: "anthropic",
    body: JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    }),
    ...overrides,
  });
}

test("matches a 400 carrying an authentication_error envelope", () => {
  assert.equal(accountAuthMatches(), true);
});

test("matches a 400 carrying a permission_error envelope", () => {
  assert.equal(
    accountAuthMatches({
      body: JSON.stringify({
        error: { type: "permission_error", message: "not authorized" },
      }),
    }),
    true,
  );
});

test("account auth error also matches a non-'anthropic' catalog speaking messages", () => {
  assert.equal(
    accountAuthMatches({
      catalogId: "my-anthropic-proxy",
      providerFmt: "messages",
    }),
    true,
  );
  assert.equal(accountAuthMatches({ catalogId: "my-anthropic-proxy" }), false);
});

test("account auth error rejects other statuses/types and malformed bodies", () => {
  assert.equal(accountAuthMatches({ status: 401 }), false); // real 401s use AUTH_FAIL_STATUS instead
  assert.equal(
    accountAuthMatches({
      body: JSON.stringify({
        error: { type: "invalid_request_error", message: "x" },
      }),
    }),
    false,
  );
  assert.equal(accountAuthMatches({ body: "not json" }), false);
  assert.equal(accountAuthMatches({ body: "{}" }), false);
});

// The credit-balance and account-auth-error detectors must stay mutually
// exclusive so a credit-balance 400 never ALSO triggers a key-disabling auth
// failure (that would defeat the point of the gentler credit-balance
// cooldown-instead-of-disable handling).
test("credit-balance and account-auth-error detectors are mutually exclusive", () => {
  const creditBody = JSON.stringify({
    error: {
      type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API.",
    },
  });
  assert.equal(
    isAnthropicCreditBalanceError({
      status: 400,
      catalogId: "anthropic",
      body: creditBody,
    }),
    true,
  );
  assert.equal(
    isAnthropicAccountAuthError({
      status: 400,
      catalogId: "anthropic",
      body: creditBody,
    }),
    false,
  );
  const authBody = JSON.stringify({
    error: { type: "authentication_error", message: "invalid x-api-key" },
  });
  assert.equal(
    isAnthropicCreditBalanceError({
      status: 400,
      catalogId: "anthropic",
      body: authBody,
    }),
    false,
  );
  assert.equal(
    isAnthropicAccountAuthError({
      status: 400,
      catalogId: "anthropic",
      body: authBody,
    }),
    true,
  );
});
