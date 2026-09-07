// Shared OpenCode attribution headers for the OpenCode Zen (`opencode`) and
// OpenCode Go (`opencode-go`) catalog providers.
//
// Every completion request carries canonical, lower-case attribution headers:
//   - x-opencode-session: stable per-conversation identity
//   - x-opencode-request: per-request/per-message id (the CLI sends the
//     message id; the gateway sends a per-attempt id, deterministic per
//     conversation identity so retries and hops share one value)
//   - x-opencode-client:  the OpenCode client identity (`cli`, matching
//     OpenCode's own captured request/source behavior)
//   - user-agent:         `opencode/<version>`, the same UA the CLI's LLM
//     request path sends (session/llm/request.ts:18 in the opencode source)
//
// Zen's server reads all four plus x-opencode-project (metrics at
// routes/zen/util/handler.ts:124-135; forwarded to the inference provider via
// headerModifier $request/$client/$project placeholders at handler.ts:235-252
// on new-inference hops). x-opencode-project is per-user workspace state the
// gateway cannot invent - NOT sent. x-zen-model is set by Zen itself
// (handler.ts:253-255) - never sent by a client.
//
// Session precedence: a non-empty caller-supplied `x-opencode-session` value
// (any casing) wins verbatim; otherwise the session is derived from the
// request body's conversation identity (prompt_cache_key / user /
// metadata.user_id) as a deterministic UUID, or falls back to one static
// UUID. Derivation reads the CLIENT-shaped body - the adapters stamp the
// header via format-tagged `opencode:session` request stages that run
// pre-conversion, because the format converters drop identity fields
// (`messages->chat` does not map `metadata.user_id`; `responses->chat`
// drops conversation-chain fields). When no stage stamped a value, the
// build phase derives from whatever body it sees and otherwise applies the
// static fallback - so retries and converted wire formats share one session
// instead of minting a new random ID per hop.

import { createHash } from "node:crypto";
import {
  DEFAULT_SESSION_ID,
  parseAnthropicUserId,
} from "../formats/session-id";

// OpenCode's own client identity, matching its source implementation and
// captured request output. Intentionally `cli`, not the integrating app name.
export const OPENCODE_CLIENT = "cli";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_REQUEST_HEADER = "x-opencode-request";
export const OPENCODE_CLIENT_HEADER = "x-opencode-client";

// The LLM-path user agent of the OpenCode CLI (packages/opencode
// package.json version at the time of pinning). The CLI's real UA is
// `opencode/${InstallationVersion}` - a plain semver, no platform suffix
// (session/llm/request.ts:18). Bump when OpenCode ships a new release.
export const OPENCODE_USER_AGENT = "opencode/1.18.29";

// Single static fallback for requests with no caller header and no body
// identity at all (truly stateless HTTP). Already a valid UUID.
export const OPENCODE_FALLBACK_SESSION_ID = DEFAULT_SESSION_ID;

const OWNED = [
  OPENCODE_SESSION_HEADER,
  OPENCODE_REQUEST_HEADER,
  OPENCODE_CLIENT_HEADER,
];


// Deterministic UUID-shaped session for a conversation-identity seed. The
// full sha256 hex is truncated to 32 chars and formatted 8-4-4-4-12, so the
// output always matches a UUID regex while staying stable for a given
// conversation (retries and converted wire formats hash to the same value).
function deterministicSessionUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Derive the OpenCode session from a request body's conversation identity,
// using the same input precedence as extractCacheKey (openai-cache routing)
// plus the raw-string `metadata.user_id` shape the Chat->Messages converter
// emits (which extractCacheKey cannot parse). Every derived value is
// UUID-shaped; returns undefined when the body carries no identity at all.
//
// Deliberately NOT used as session input: `previous_response_id` (per-turn,
// not per-conversation) and message content (identical openers would
// collide).
export function openCodeSessionFromBody(
  body: Record<string, unknown>,
): string | undefined {
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key)
    return deterministicSessionUuid(body.prompt_cache_key);

  if (typeof body.user === "string" && body.user)
    return deterministicSessionUuid(body.user);

  // `metadata` may be a non-object on Responses-shaped bodies - guard before
  // reading user_id.
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const identity = parseAnthropicUserId(meta.user_id);
    if (identity) return deterministicSessionUuid(identity.session_id);
    if (typeof meta.user_id === "string" && meta.user_id)
      return deterministicSessionUuid(meta.user_id);
  }

  return undefined;
}

// Request-transform side effect: stamp the derived session onto the attempt's
// mutable outbound header table so it survives the format conversion into the
// build phase (where withOpenCodeAttribution treats it as the session). A
// no-op when the body carries no identity or when ANY case variant of the
// session header is already present - an explicit caller choice is never
// rehashed or overwritten. Never touches the body or URL.
export function stampOpenCodeSessionHeader(
  body: Record<string, unknown>,
  headers: Record<string, string> | undefined,
): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === OPENCODE_SESSION_HEADER) return;
  }
  const session = openCodeSessionFromBody(body);
  if (session) headers[OPENCODE_SESSION_HEADER] = session;
}


// Return a NEW header map suitable for a `BuiltRequest`: every case variant
// of the owned headers is removed, then exactly the canonical lower-case
// keys are written. The input map is left untouched; unrelated headers are
// preserved verbatim.
export function withOpenCodeAttribution(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Record<string, string> {
  let session: string | undefined;
  let request: string | undefined;
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === OPENCODE_SESSION_HEADER && !session) {
      const value = headers[key];
      if (typeof value === "string" && value) session = value;
    } else if (lower === OPENCODE_REQUEST_HEADER && !request) {
      const value = headers[key];
      if (typeof value === "string" && value) request = value;
    }
  }
  // Session: caller value wins verbatim; else derived from the body's
  // conversation identity; else the static fallback UUID.
  if (!session)
    session = openCodeSessionFromBody(body) ?? OPENCODE_FALLBACK_SESSION_ID;
  // Request: caller value wins verbatim (the CLI puts its message id here);
  // else a deterministic UUID-shaped per-conversation id (session seed or the
  // static fallback, plus a role suffix so the two headers never collide).
  if (!request)
    request = deterministicSessionUuid(
      (openCodeSessionFromBody(body) ?? OPENCODE_FALLBACK_SESSION_ID) +
        ":request",
    );

  const out: Record<string, string> = { ...headers };
  for (const key of Object.keys(out)) {
    if (OWNED.includes(key.toLowerCase())) delete out[key];
  }
  out[OPENCODE_SESSION_HEADER] = session;
  out[OPENCODE_REQUEST_HEADER] = request;
  out[OPENCODE_CLIENT_HEADER] = OPENCODE_CLIENT;
  // OpenCode's own UA, unless the caller already set one under any casing -
  // an explicit client identity is never clobbered.
  if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent"))
    out["user-agent"] = OPENCODE_USER_AGENT;
  return out;
}
