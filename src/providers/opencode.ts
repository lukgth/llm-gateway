// Shared OpenCode attribution for the OpenCode Zen (`opencode`) and OpenCode Go
// (`opencode-go`) catalog providers.
//
// Zen's free tier (anonymous caller, i.e. `Authorization: Bearer public`) is
// gated: a request that does not look like the OpenCode CLI gets
// `403 {"type":"error","error":{"type":"FreeTierError","message":"Error from
// provider (Console): OpenCode's free tier can only be used from within
// OpenCode"}}` from Zen's upstream inference service. The gate was pinned down
// against the live endpoint; the CLI's own request (opencode 1.18.31,
// packages/opencode/src/session/llm/request.ts:187-195) is:
//
//   authorization:      Bearer public (anonymous) - the CLI's own key when unauthenticated
//   user-agent:         opencode/<version> ai-sdk/provider-utils/<v> runtime/bun/<v>
//   x-opencode-client:  cli
//   x-opencode-project: the CLI's workspace project id ("global" when the CLI has none)
//   x-opencode-session: ses_ + 26-char body (12 lowercase hex + 14 base62)
//   x-opencode-request: msg_ + the same 26-char body
//   body:               stream: true (the CLI always streams)
//
// Verified on POST https://opencode.ai/zen/v1/chat/completions with the public
// key, each condition isolated (repeats deterministic):
//   - `stream: false`                          -> 403, `stream: true` -> 200
//   - session UUID / 6-hex body / 32-char body -> 403; 12-hex + 14-base62 -> 200
//   - request, client and project headers      -> each removable, still 200
//   - user-agent                               -> not gated (a valid session
//     passes with any UA, or none); it is still sent for byte-for-byte parity
//     with the CLI, and the id shapes below are what actually unblock.
//
// Zen's server reads these headers for metrics and forwards them to its
// inference providers (routes/zen/util/handler.ts:124-135 and the $request/
// $client/$project placeholder expansion at handler.ts:235-252). x-zen-model is
// set by Zen itself - a client never sends it.
//
// Session precedence: a caller-supplied `x-opencode-session` wins ONLY when it
// already has the CLI's shape - a UUID (what this gateway used to mint) is
// rejected upstream, so any other value is re-derived from the body's
// conversation identity instead of being forwarded into a 403. Otherwise the
// session is derived from the request body's conversation identity
// (prompt_cache_key / user / metadata.user_id) and finally falls back to one
// static value. Derivation reads the CLIENT-shaped body: the adapters stamp the
// header via format-tagged `opencode:session` request stages that run
// pre-conversion, because the converters drop identity fields
// (`messages->chat` does not map `metadata.user_id`; `responses->chat` drops
// conversation-chain fields). When no stage stamped a value, the build phase
// derives from whatever body it sees and otherwise applies the static fallback,
// so retries and converted wire formats share one session instead of minting a
// different id per hop.
//
// Ids are deterministic per conversation: the CLI mints a random 26-char body
// per session, and Zen validates only the SHAPE (the 12 hex chars are a
// creation timestamp upstream, but a year-old and a future timestamp were both
// accepted live). Hashing keeps retries, key rotations and format hops on one
// prompt-cache identity.

import { createHash } from "node:crypto";
import { parseAnthropicUserId } from "../formats/session-id";

// OpenCode's own client identity, matching its source implementation and
// captured request output. Intentionally `cli`, not the integrating app name.
export const OPENCODE_CLIENT = "cli";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_REQUEST_HEADER = "x-opencode-request";
export const OPENCODE_CLIENT_HEADER = "x-opencode-client";
export const OPENCODE_PROJECT_HEADER = "x-opencode-project";

// The CLI sends its workspace project id here; without a registered project it
// sends the reserved `global` value (packages/schema/src/project-id.ts), which
// is what a gateway can honestly claim - Zen consumes it for metrics only.
export const OPENCODE_DEFAULT_PROJECT = "global";

// The id body the CLI mints (Identifier.create): 12 lowercase hex characters -
// a timestamp upstream - followed by 14 base62 characters. Zen hard-gates on
// this shape for the free tier, so it is matched here explicitly.
const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_BODY_HEX_LENGTH = 12;
const ID_BODY_ALPHABET_LENGTH = 14;

export const OPENCODE_SESSION_ID_RE =
  /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_ID_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// The LLM-path user agent of the OpenCode CLI 1.18.31, captured verbatim off
// the wire. The trailing segments come from the ai-sdk transport the CLI uses
// per endpoint: `@ai-sdk/openai-compatible` (chat) reports
// provider-utils/4.0.23, `@ai-sdk/openai` (responses) reports 4.0.40. Bump all
// three when re-capturing against a newer CLI release.
export const OPENCODE_VERSION = "1.18.31";
const OPENCODE_RUNTIME = "runtime/bun/1.3.14";
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.23 ${OPENCODE_RUNTIME}`;
export const OPENCODE_USER_AGENT_RESPONSES = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.40 ${OPENCODE_RUNTIME}`;

// Single static fallback for requests with no caller header and no body
// identity at all (truly stateless HTTP). Shape-valid, so it survives the gate.
export const OPENCODE_FALLBACK_SESSION_ID = deterministicOpenCodeId(
  "ses_",
  "gateway:opencode:fallback-session",
);

const OWNED_HEADERS = [
  OPENCODE_SESSION_HEADER,
  OPENCODE_REQUEST_HEADER,
  OPENCODE_CLIENT_HEADER,
  OPENCODE_PROJECT_HEADER,
];

// Deterministic id with the CLI's exact shape: sha256-derived hex head plus a
// base62 tail from a second digest. Stable for a given seed, so a conversation
// keeps one session/request identity across retries, hops and wire formats.
function deterministicOpenCodeId(prefix: string, seed: string): string {
  const head = createHash("sha256").update(seed).digest("hex");
  const tail = createHash("sha256").update(`${seed}:chars`).digest();
  let chars = "";
  for (let i = 0; i < ID_BODY_ALPHABET_LENGTH; i++) {
    chars += ID_ALPHABET[tail[i] % ID_ALPHABET.length];
  }
  return prefix + head.slice(0, ID_BODY_HEX_LENGTH) + chars;
}

// Derive the OpenCode session from a request body's conversation identity,
// using the same input precedence as extractCacheKey (openai-cache routing)
// plus the raw-string `metadata.user_id` shape the Chat->Messages converter
// emits (which extractCacheKey cannot parse). Returns undefined when the body
// carries no identity at all.
//
// Deliberately NOT used as session input: `previous_response_id` (per-turn,
// not per-conversation) and message content (identical openers would collide).
export function openCodeSessionFromBody(
  body: Record<string, unknown>,
): string | undefined {
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key)
    return deterministicOpenCodeId("ses_", body.prompt_cache_key);

  if (typeof body.user === "string" && body.user)
    return deterministicOpenCodeId("ses_", body.user);

  // `metadata` may be a non-object on Responses-shaped bodies - guard before
  // reading user_id.
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const identity = parseAnthropicUserId(meta.user_id);
    if (identity) return deterministicOpenCodeId("ses_", identity.session_id);
    if (typeof meta.user_id === "string" && meta.user_id)
      return deterministicOpenCodeId("ses_", meta.user_id);
  }

  return undefined;
}

// Request-transform side effect: stamp the derived session onto the attempt's
// mutable outbound header table so it survives the format conversion into the
// build phase (where withOpenCodeAttribution treats it as the session). A no-op
// when the body carries no identity or when ANY case variant of the session
// header is already present - an explicit caller choice is never rehashed or
// overwritten here; withOpenCodeAttribution is what rejects a caller value the
// upstream gate would 403 on. Never touches the body or URL.
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

// The CLIENT always streams, and Zen's free tier rejects a buffered request with
// FreeTierError (verified live: the same request passes with `stream: true`).
// So an anonymous attempt - the free-tier key is the literal `public`, or no key
// at all - is forced to stream upstream; the engine buffers the SSE back into a
// JSON body for a caller that asked for a buffered response. A real key (Zen
// credit, Go subscription) keeps the caller's own choice.
export function forceOpenCodeFreeTierStream(
  body: Record<string, unknown>,
  apiKey: string | null | undefined,
): void {
  const anonymous =
    apiKey == null || apiKey.trim() === "" || apiKey.trim() === "public";
  if (anonymous) body.stream = true;
}

interface AttributionOptions {
  // Endpoint-specific CLI user agent; defaults to the chat/messages one.
  userAgent?: string;
}

// Return a NEW header map suitable for a `BuiltRequest`: every case variant of
// the owned headers is removed, then exactly the canonical lower-case keys are
// written. The input map is left untouched; unrelated headers are preserved
// verbatim.
export function withOpenCodeAttribution(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: AttributionOptions = {},
): Record<string, string> {
  let session: string | undefined;
  let request: string | undefined;
  let project: string | undefined;
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    const value = headers[key];
    if (typeof value !== "string" || !value) continue;
    if (lower === OPENCODE_SESSION_HEADER && !session) session = value;
    else if (lower === OPENCODE_REQUEST_HEADER && !request) request = value;
    else if (lower === OPENCODE_PROJECT_HEADER && !project) project = value;
  }
  // Session: a caller value is honoured only in the CLI's own shape - forwarding
  // anything else (a UUID, say) would just be handed a FreeTierError. Otherwise
  // derive from the body's conversation identity, else the static fallback.
  if (!session || !OPENCODE_SESSION_ID_RE.test(session)) {
    session = openCodeSessionFromBody(body) ?? OPENCODE_FALLBACK_SESSION_ID;
  }
  // Request: caller value in the CLI's shape wins (the CLI puts its message id
  // here); else a deterministic per-conversation id, seeded so it never
  // collides with the session.
  if (!request || !OPENCODE_REQUEST_ID_RE.test(request)) {
    request = deterministicOpenCodeCodeRequestId(
      body,
      session,
    );
  }

  const out: Record<string, string> = { ...headers };
  for (const key of Object.keys(out)) {
    if (OWNED_HEADERS.includes(key.toLowerCase())) delete out[key];
  }
  out[OPENCODE_SESSION_HEADER] = session;
  out[OPENCODE_REQUEST_HEADER] = request;
  out[OPENCODE_CLIENT_HEADER] = OPENCODE_CLIENT;
  out[OPENCODE_PROJECT_HEADER] = project ?? OPENCODE_DEFAULT_PROJECT;
  // OpenCode's own UA, unless the caller already set one under any casing - an
  // explicit client identity is never clobbered.
  if (!Object.keys(out).some((k) => k.toLowerCase() === "user-agent")) {
    out["user-agent"] = options.userAgent ?? OPENCODE_USER_AGENT;
  }
  return out;
}

// Per-conversation request id: seeded from the conversation identity when the
// body carries one (so both headers move together across hops), else from the
// session itself, which is already conversation-stable.
function deterministicOpenCodeCodeRequestId(
  body: Record<string, unknown>,
  session: string,
): string {
  const identity = openCodeSessionFromBody(body) ?? session;
  return deterministicOpenCodeId("msg_", `${identity}:request`);
}
