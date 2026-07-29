// Detection for the Claude Code "long-context usage credits" 429.
//
// Anthropic returns a 429 rate_limit_error when a Claude Code subscription key's
// plan lacks the usage credits to serve a LONG-CONTEXT request. It is NOT a
// normal rate limit and NOT a key fault - the key is healthy, its plan just
// can't take this particular request. The engine treats it as a per-key "skip"
// signal: rotate to another key (no health penalty, no cooldown, no error log),
// and only fail the provider over once EVERY key is credit-less. See forward()'s
// credit rotation + KeyHealthStore.markCreditProven.

/** The canonical message Anthropic returns for this condition. Exported for the
 *  reason strings + tests that reference the exact wording. */
export const LONG_CONTEXT_USAGE_CREDITS_MESSAGE =
  "Usage credits are required for long context requests.";

// Anthropic has shipped this signal under more than one phrasing ("Usage credits
// are required…" and the older "Extra usage is required…"), and may append/adjust
// trailing wording. Match the stable core of each by substring so a minor
// message tweak upstream doesn't silently disable the rotation.
const LONG_CONTEXT_CREDIT_SUBSTRINGS = [
  "Usage credits are required for long context",
  "Extra usage is required for long context",
];

// Detect the long-context credits 429. Gated to Claude Code (only its
// subscription billing path produces this signal) but NOT to any model - any
// model on a Claude Code key can hit its plan's long-context credit ceiling.
export function isClaudeCodeUsageCreditsError(input: {
  status: number;
  catalogId: string | null | undefined;
  upstreamModel: string;
  body: string;
}): boolean {
  if (input.status !== 429 || input.catalogId !== "claude-code") return false;

  try {
    const parsed = JSON.parse(input.body) as {
      error?: { type?: unknown; message?: unknown };
    };
    if (parsed.error?.type !== "rate_limit_error") return false;
    const message = parsed.error.message;
    return (
      typeof message === "string" &&
      LONG_CONTEXT_CREDIT_SUBSTRINGS.some((s) => message.includes(s))
    );
  } catch {
    return false;
  }
}

// The canonical message Anthropic returns when a Claude Code key's plan can't
// serve a PREMIUM model (Fable/Mythos) for lack of usage credits - the sibling
// of the long-context signal above, but scoped to the MODEL rather than the
// request size. Exported for reason strings + tests.
export const MODEL_USAGE_CREDITS_MESSAGE =
  "Usage credits are required for this model.";

// Stable core of the model-credits message (Anthropic may append trailing text).
const MODEL_CREDIT_SUBSTRINGS = ["credits are required for this model"];

// Detect the premium-model usage-credits 429. Like the long-context signal it is
// NOT a key fault and NOT a rate limit - a plain Claude Code key simply has no
// Fable/Mythos access; it can still serve base models. The engine treats it as a
// per-key "skip" (rotate to another key, no health penalty, no cooldown, no
// error log), and only fails the provider over once EVERY key lacks it - same as
// the long-context path, but WITHOUT touching long-context credit-proof
// bookkeeping (a premium-less key may still hold long-context credits).
// Recognised by the stable message phrasing OR the structured
// `details.error_code === "credits_required"`, and deliberately NOT matched when
// the body is actually the long-context variant (so the two stay distinct).
export function isClaudeCodeModelCreditsError(input: {
  status: number;
  catalogId: string | null | undefined;
  upstreamModel: string;
  body: string;
}): boolean {
  if (input.status !== 429 || input.catalogId !== "claude-code") return false;

  try {
    const parsed = JSON.parse(input.body) as {
      error?: { type?: unknown; message?: unknown; details?: unknown };
    };
    if (parsed.error?.type !== "rate_limit_error") return false;
    const message =
      typeof parsed.error.message === "string" ? parsed.error.message : "";
    // Never treat the long-context signal as a model-credits one (keeps the two
    // detectors mutually exclusive so either can be used standalone).
    if (LONG_CONTEXT_CREDIT_SUBSTRINGS.some((s) => message.includes(s)))
      return false;
    if (MODEL_CREDIT_SUBSTRINGS.some((s) => message.includes(s))) return true;
    const details = parsed.error.details;
    const errorCode =
      details && typeof details === "object"
        ? (details as { error_code?: unknown }).error_code
        : undefined;
    return errorCode === "credits_required";
  } catch {
    return false;
  }
}

// Anthropic's pay-as-you-go "out of credits" 400 - the account's prepaid
// balance is empty. Distinct from the Claude Code subscription signals above
// (those are 429s scoped to claude-code); this is a plain invalid_request_error
// any Anthropic API key can return once its balance runs dry. Matched by
// substring (not exact message) so trailing wording changes upstream don't
// silently disable detection.
const CREDIT_BALANCE_SUBSTRINGS = ["credit balance is too low"];

// Detect the "credit balance too low" 400. NOT a key fault in the auth sense -
// the key/account is otherwise valid, it just has no funds - so the engine
// should penalize (rate-limit/cooldown) rather than disable the key, and
// rotate to another one. Gated to the official Anthropic catalog since that's
// the only adapter with a prepaid-balance billing model.
export function isAnthropicCreditBalanceError(input: {
  status: number;
  catalogId: string | null | undefined;
  body: string;
}): boolean {
  if (input.status !== 400 || input.catalogId !== "anthropic") return false;

  try {
    const parsed = JSON.parse(input.body) as {
      error?: { type?: unknown; message?: unknown };
    };
    if (parsed.error?.type !== "invalid_request_error") return false;
    const message = parsed.error.message;
    return (
      typeof message === "string" &&
      CREDIT_BALANCE_SUBSTRINGS.some((s) => message.toLowerCase().includes(s))
    );
  } catch {
    return false;
  }
}
