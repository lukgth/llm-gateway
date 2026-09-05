// Shared OpenCode attribution headers for the OpenCode Zen (`opencode`) and
// OpenCode Go (`opencode-go`) catalog providers.
//
// Every completion request carries two canonical, lower-case headers:
//   - x-opencode-session: stable per-session identity
//   - x-opencode-client:  the OpenCode client identity (`cli`, matching
//     OpenCode's own captured request/source behavior)
//
// Session precedence: a non-empty caller-supplied `x-opencode-session` value
// (any casing) wins; otherwise the gateway's existing stable
// body-derived/fallback identity from `extractCacheKey()` is used, so retries
// and converted wire formats share one session instead of minting a new
// random ID per hop.

import { extractCacheKey } from "../formats/session-id";

// OpenCode's own client identity, matching its source implementation and
// captured request output. Intentionally `cli`, not the integrating app name.
export const OPENCODE_CLIENT = "cli";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_CLIENT_HEADER = "x-opencode-client";

const OWNED = [OPENCODE_SESSION_HEADER, OPENCODE_CLIENT_HEADER];

// Return a NEW header map suitable for a `BuiltRequest`: every case variant
// of the owned headers is removed, then exactly the canonical lower-case
// keys are written. The input map is left untouched; unrelated headers are
// preserved verbatim.
export function withOpenCodeAttribution(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Record<string, string> {
  let session: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === OPENCODE_SESSION_HEADER) {
      const value = headers[key];
      if (typeof value === "string" && value) {
        session = value;
        break;
      }
    }
  }
  if (!session) session = extractCacheKey(body);

  const out: Record<string, string> = { ...headers };
  for (const key of Object.keys(out)) {
    if (OWNED.includes(key.toLowerCase())) delete out[key];
  }
  out[OPENCODE_SESSION_HEADER] = session;
  out[OPENCODE_CLIENT_HEADER] = OPENCODE_CLIENT;
  return out;
}
