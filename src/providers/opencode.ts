// Shared OpenCode attribution for the OpenCode Zen (`opencode`) and OpenCode Go
// (`opencode-go`) catalog providers.
//
// Zen's free tier (anonymous caller, i.e. `Authorization: Bearer public`) is
// gated per request by TWO independent conditions, each pinned down live
// against https://opencode.ai/zen/v1/* (and the /inference/openai/v1/* alias):
//
//   1. TRANSPORT - the TLS ClientHello must be the OpenCode CLI's. Every
//      non-Bun-fetch stack is refused with
//        429 {"type":"error","error":{"type":"FreeUsageLimitError", ...}}
//      regardless of the HTTP request: curl (OpenSSL, h1 and h2), Node
//      https (OpenSSL), Python, and even Bun's own node:https path - which
//      negotiates a Node-compat ClientHello - are all refused, while
//      `fetch` inside the same Bun runtime (BoringSSL, ALPN http/1.1, Chrome
//      cipher order, EXT 5/18 present) is accepted. An exact byte replay of a
//      captured CLI request (identical headers, body, ids and egress IP) still
//      fails over Node's TLS, so nothing at the HTTP layer changes the verdict.
//      Node cannot emit that ClientHello, so the engine routes anonymous
//      free-tier requests through its own TLS client instead (see
//      src/providers/opencode-tls); this module only marks which requests need it.
//
//   2. PROMPT PROFILE - the body must look like one of the CLI's own requests.
//      With (1) satisfied, exactly two profiles pass:
//        - the CLI's title-generation system prompt and NO tools at all, or
//        - an `<env>` environment block in a system message AND a tool named
//          the literal lowercase `read` (case-sensitive).
//      Refused, verified one variable at a time: a tool-less request with no
//      system prompt, `<env>` without a `read` tool, `bash` without `read`,
//      `read` without `<env>`, the OpenCode agent prompt without tools, a
//      title prompt WITH tools, and random text of any length. The `<env>`
//      block may be minimal (`<env>Working directory: /</env>`) and its values
//      are not checked. The gateway takes the second profile for every
//      free-tier request: it ensures a `read` tool entry and appends
//      OPENCODE_ENV_MARKER to the system prompt. The title-prompt profile is
//      never used - it makes models answer as a title generator (measured).
//
// Attribution headers the CLI sends (all of them metrics/cache for Zen; none of
// them grants free-tier access):
//
//   authorization:         Bearer public (the CLI's own key when unauthenticated)
//   user-agent:            opencode/<version> ai-sdk/provider-utils/<v> runtime/bun/<v>
//   x-opencode-session:    ses_ + a 12-hex DESCENDING timestamp + 14 base62
//   x-opencode-session-id: the same session (the CLI's real session id)
//   x-session-affinity / X-Session-Id: the same session (older clients)
//   x-opencode-request:    msg_ + the same 26-char body
//   x-opencode-client:     the CLI's app name (`cli`)
//   x-opencode-project:    the CLI's workspace project id ("global" when none)
//   body:                  stream: true + stream_options.include_usage
//
// A refusal is a 429 (or 403/451) FreeUsageLimitError/FreeTierError; see
// isOpencodeFreeTierRefusal - it verdicts the request, never the credential.
//
// Those injected tools are a capability the client never asked for, and models
// do call them - so the adapter also owns the response side of the deal: an
// injected name that matches one of the CLIENT's own tools becomes an ALIAS
// carrying the client's schema (and its calls are renamed back to the client's
// spelling), while an injected name with no counterpart is dropped from the
// response rather than handed to a client that cannot run it. See
// OpencodeToolPlan and the guard section below.
//
// Session precedence: a caller-supplied `x-opencode-session` wins ONLY when it
// has the CLI's shape AND a fresh clock value - a UUID or a hash-derived id
// (what this gateway used to mint) is rejected upstream, so any such value is
// re-derived from the body's conversation identity instead of being forwarded.
// Otherwise the session is derived from the request body's conversation
// identity (prompt_cache_key / user / metadata.user_id) and finally falls back
// to the cached fallback. Derivation reads the CLIENT-shaped body: the adapters
// stamp the header via format-tagged `opencode:session` request stages that run
// pre-conversion, because the converters drop identity fields
// (`messages->chat` does not map `metadata.user_id`; `responses->chat` drops
// conversation-chain fields). When no stage stamped a value, the build phase
// derives from whatever body it sees and otherwise applies the fallback, so
// retries and converted wire formats share one session instead of minting a
// different id per hop.
//
// Ids keep the CLI's exact shape: Identifier.descending's 12-hex timestamp head
// followed by a 14-char base62 tail. The tail is the gateway's stable part:
// hashing the conversation seed keeps retries, key rotations and format hops on
// one prompt-cache identity, and a day-long cache bounds the clock work.

import { createHash, randomInt } from "node:crypto";
import { parseAnthropicUserId } from "../formats/session-id";

// OpenCode's own client identity, matching its source implementation and
// captured request output. Intentionally `cli`, not the integrating app name.
export const OPENCODE_CLIENT = "cli";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_SESSION_ID_HEADER = "x-opencode-session-id";
export const OPENCODE_AFFINITY_HEADER = "x-session-affinity";
export const OPENCODE_SESSION_ID_ALIAS_HEADER = "x-session-id";
export const OPENCODE_REQUEST_HEADER = "x-opencode-request";
export const OPENCODE_CLIENT_HEADER = "x-opencode-client";
export const OPENCODE_PROJECT_HEADER = "x-opencode-project";

// The CLI sends its workspace project id here; without a registered project it
// sends the reserved `global` value (packages/schema/src/project-id.ts), which
// is what a gateway can honestly claim - Zen consumes it for metrics only.
export const OPENCODE_DEFAULT_PROJECT = "global";

// The id the CLI mints (Identifier.descending): 12 lowercase hex characters -
// a DESCENDING timestamp - followed by 14 base62 characters. Zen hard-gates on
// both the shape and the timestamp's freshness for the free tier. The 12-hex
// head is `~((Date.now() * 0x1000) + counter)` truncated to 48 bits; see
// openCodeId.
const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_BODY_HEX_LENGTH = 12;
const ID_BODY_ALPHABET_LENGTH = 14;
const ID_HEAD_RE = /^(?:ses_|msg_)([0-9a-f]{12})/;
const ID_HEAD_MASK = (1n << 48n) - 1n;
const ID_TIMESTAMP_WRAP = 1n << 36n;

export const OPENCODE_SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_ID_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// A head minted now, an hour or seven days ago is accepted live; a fabricated
// hash-derived head is refused. Keep a wide margin below the verified window so
// a cached per-conversation id can be reused for a full day and a caller's own
// session header is only forwarded while it still passes the same check.
const SESSION_ID_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
// The CLI's clock is the upstream's reference. A small past margin keeps a
// freshly minted id on the accepted side of any clock skew.
const SESSION_ID_CLOCK_MARGIN_MS = 5 * 60 * 1000;

// The LLM-path user agent of the OpenCode CLI, captured from a live 2.x build:
// `opencode/<version> ai-sdk/provider-utils/<v> runtime/bun/<v>`. Both the 1.x
// and the 2.x binaries emit this ai-sdk-annotated form (the channel/artifact
// form is not what any released client sends), and the free tier parses the
// version out of it: a client reporting anything below 1.18.0 is answered
// `426 UpgradeRequired` ("OpenCode 1.18.0 or newer is required to use the free
// tier"), which a `0.0.0-dev-*` snapshot hits while `1.19.4` passes. Keep this
// at a real release number and bump it when re-capturing.
export const OPENCODE_VERSION = process.env.OPENCODE_CLI_VERSION ?? "2.1.4";
const OPENCODE_AI_SDK_TRANSPORT =
  "ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4";
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION} ${OPENCODE_AI_SDK_TRANSPORT}`;
export const OPENCODE_USER_AGENT_RESPONSES = OPENCODE_USER_AGENT;

// Fallback seed for requests with no caller header and no body identity at all
// (truly stateless HTTP). The exported value is built below, after the
// generator it depends on; `withOpenCodeAttribution` re-derives it through the
// cache so a long-lived process never forwards a stale head.
const OPENCODE_FALLBACK_SEED = "gateway:opencode:fallback-session";

const OWNED_HEADERS = [
  OPENCODE_SESSION_HEADER,
  OPENCODE_SESSION_ID_HEADER,
  OPENCODE_AFFINITY_HEADER,
  OPENCODE_SESSION_ID_ALIAS_HEADER,
  OPENCODE_REQUEST_HEADER,
  OPENCODE_CLIENT_HEADER,
  OPENCODE_PROJECT_HEADER,
];

// The CLI's id head, byte for byte (Identifier.create): the low 48 bits of
// `(Date.now() * 0x1000) + counter` - complemented for descending ids - as 12
// lowercase hex. The counter separates ids minted within one millisecond and
// starts at 1: the CLI increments before using it, and Zen treats a zero
// counter as a fabricated id (`429 FreeUsageLimitError`, measured).
let headMs = -1;
let headCounter = 0;
function openCodeHead(ms: number, descending: boolean): string {
  if (ms !== headMs) {
    headMs = ms;
    headCounter = 0;
  }
  headCounter = headCounter >= 0xfff ? 1 : headCounter + 1;
  const current = BigInt(ms) * 0x1000n + BigInt(headCounter);
  const value = descending ? ~current : current;
  let head = "";
  for (let i = 0; i < ID_BODY_HEX_LENGTH / 2; i++) {
    head += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  return head;
}

// The tail is the only part a gateway may choose: 14 base62 characters derived
// from the conversation seed, so retries, key rotations and format hops keep
// one identity while the head stays a truthful clock value.
function openCodeIdTail(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  let tail = "";
  for (let i = 0; i < ID_BODY_ALPHABET_LENGTH; i++) {
    tail += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  }
  return tail;
}

interface CachedOpenCodeId {
  id: string;
  expiresAt: number;
}

// A single-request id, minted exactly like the CLI's Identifier: a fresh clock
// head plus 14 crypto-random base62 characters. Anonymous free-tier requests
// use these instead of the derived/cached ids - Zen meters the free allowance
// per identity and refuses one it has already served, so a conversation-stable
// id eventually answers `429 FreeUsageLimitError` while a fresh one succeeds
// (the CLI mints a new session per run and keeps working).
function mintOpenCodeId(
  prefix: "ses_" | "msg_",
  descending: boolean,
  now = Date.now(),
): string {
  let tail = "";
  for (let i = 0; i < ID_BODY_ALPHABET_LENGTH; i++) {
    tail += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return `${prefix}${openCodeHead(now, descending)}${tail}`;
}

// Per-seed ids are cached for a day: the gate accepts a seven-day-old head
// (verified live), and a day keeps a cached value far from that boundary while
// preserving prompt-cache identity across a conversation's requests.
const openCodeIds = new Map<string, CachedOpenCodeId>();
const OPENCODE_ID_CACHE_MAX = 4096;

function openCodeId(prefix: "ses_" | "msg_", seed: string): string {
  const key = `${prefix}${seed}`;
  const now = Date.now();
  const cached = openCodeIds.get(key);
  if (cached && cached.expiresAt > now) return cached.id;
  const id = `${prefix}${openCodeHead(
    Math.floor(now - SESSION_ID_CLOCK_MARGIN_MS),
    true,
  )}${openCodeIdTail(seed)}`;
  if (!cached && openCodeIds.size >= OPENCODE_ID_CACHE_MAX) {
    const oldest = openCodeIds.keys().next().value;
    if (oldest !== undefined) openCodeIds.delete(oldest);
  }
  openCodeIds.set(key, { id, expiresAt: now + SESSION_ID_TTL_MS });
  return id;
}

// Age of the clock value encoded in an id head, modulo the 48-bit timestamp
// wrap. A future head wraps to a huge age, exactly like a stale one.
function openCodeIdAgeMs(id: string): number | null {
  const match = ID_HEAD_RE.exec(id);
  if (!match) return null;
  const head = BigInt(`0x${match[1]}`);
  const minted = (~head & ID_HEAD_MASK) >> 12n;
  const now = BigInt(Date.now()) % ID_TIMESTAMP_WRAP;
  let age = now - minted;
  if (age < 0n) age += ID_TIMESTAMP_WRAP;
  return Number(age);
}

// A caller-supplied attribution id is forwarded only while the gate would still
// accept it. An old/fabricated head is re-derived; a UUID or any other shape is
// rejected by the shape test before this.
export function isFreshOpenCodeId(id: string): boolean {
  const age = openCodeIdAgeMs(id);
  return age !== null && age <= SESSION_ID_MAX_AGE_MS;
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
    return openCodeId("ses_", body.prompt_cache_key);

  if (typeof body.user === "string" && body.user)
    return openCodeId("ses_", body.user);

  // `metadata` may be a non-object on Responses-shaped bodies - guard before
  // reading user_id.
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const identity = parseAnthropicUserId(meta.user_id);
    if (identity) return openCodeId("ses_", identity.session_id);
    if (typeof meta.user_id === "string" && meta.user_id)
      return openCodeId("ses_", meta.user_id);
  }

  return undefined;
}

// Eager value for importers/tests; the build path re-derives it through the
// cache so a long-lived process never forwards a stale head.
export const OPENCODE_FALLBACK_SESSION_ID = openCodeId(
  "ses_",
  OPENCODE_FALLBACK_SEED,
);

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

// The CLI's own key when it is unauthenticated, sent as `Bearer public`. Zen
// reads it as "anonymous caller" and gates that caller on the free tier.
export const OPENCODE_ANONYMOUS_KEY = "public";

// The anonymous free-tier identity: Zen's public key, an unset key, or an
// empty one. A provider with no key configured is the same anonymous caller to
// Zen - the engine may still have forwarded the CLIENT's own gateway bearer
// (see TransformCtx.apiKey), which must be overwritten rather than preserved,
// since Zen would read it as a bad credential.
export function isOpencodeAnonymousKey(
  apiKey: string | null | undefined,
): boolean {
  return (
    apiKey == null ||
    apiKey.trim() === "" ||
    apiKey.trim() === OPENCODE_ANONYMOUS_KEY
  );
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
  if (isOpencodeAnonymousKey(apiKey)) body.stream = true;
}

// The free-tier gate also inspects the User-Agent: the caller must look like an
// OpenCode release. Verified live (the rest of the contract held constant): no
// UA or `curl/8.5.0` -> 403 FreeTierError; the current
// `opencode/latest/2.0.32/cli`, the older ai-sdk-annotated
// `opencode/1.18.31 ai-sdk/...`, and the channel/version/role form all pass.
// A stale/foreign UA is replaced by this gateway's pinned identity rather than
// forwarded into a refusal.
const OPENCODE_UA_VERSION_RE =
  /\bopencode\/(?:[a-z][a-z0-9-]*\/)?(\d+)\.(\d+)/i;
const OPENCODE_UA_MIN_MAJOR = 1;
const OPENCODE_UA_MIN_MINOR = 17;

export function satisfiesOpencodeUserAgentContract(
  ua: string | null | undefined,
): boolean {
  if (typeof ua !== "string") return false;
  const match = OPENCODE_UA_VERSION_RE.exec(ua);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > OPENCODE_UA_MIN_MAJOR) return true;
  return major === OPENCODE_UA_MIN_MAJOR && minor >= OPENCODE_UA_MIN_MINOR;
}

// The free-tier prompt profile (condition 2 in the header) needs a tool named
// the literal lowercase `read` alongside the `<env>` system block. That name is
// case-sensitive: the `Read` that Claude Code and most coding clients send does
// NOT satisfy it, so the name is injected rather than matched loosely (an
// existing caller entry always wins; a caller `Read` is aliased, see
// OpencodeToolPlan). Only `read` is required - `bash` alone, `[]`, and any
// other name are refused - so the default injection is just that one entry.
// The entry is the CLI's OWN read definition (description + JSON Schema) from
// its source, so the outbound body stays faithful to the CLI.
const OPENCODE_PLACEHOLDER_TOOLS = ["read"];

// The CLI's own definitions, keyed by tool name. Descriptions and schemas
// mirror the 2.0.32 source; the free-tier gate matches the `read` name only,
// never the contents.
export const OPENCODE_FREE_TIER_TOOL_DEFINITIONS: Record<
  string,
  { description: string; parameters: Record<string, unknown> }
> = {
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command string to execute",
        },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  glob: {
    description:
      'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files against",
        },
        path: {
          type: "string",
          description:
            "Directory to search. Defaults to the current working directory.",
        },
        hidden: {
          type: "boolean",
          description: "Include hidden files and directories (default: false).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 9007199254740991,
          description:
            "Maximum number of matching files to return (default: 100)",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  grep: {
    description:
      "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          minLength: 1,
          description:
            "Regular expression or literal text to match in file contents.",
        },
        path: {
          type: "string",
          description:
            "File or directory to search. Defaults to the current working directory.",
        },
        include: {
          type: "string",
          description:
            'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
        },
        literal: {
          type: "boolean",
          description:
            "Treat `pattern` as exact text instead of a regular expression (default: false).",
        },
        caseSensitive: {
          type: "boolean",
          description: "Use case-sensitive matching (default: true).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 9007199254740991,
          description:
            "Maximum number of matching lines to return (default: 100)",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory to read",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description:
            "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

// Fallback for a name the CLI does not define, which only an operator-added
// OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS override can produce: a neutral
// description plus the empty object schema. The gate matches tool NAMES only,
// never their contents.
const OPENCODE_NEUTRAL_TOOL_DESCRIPTION =
  "This entry exists for API compatibility with the OpenCode CLI tool list.";
const OPENCODE_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_PLACEHOLDER_TOOLS = 32;

// The name the live gate requires BY NAME (see above). It is re-added to
// whatever the operator configured, so no override - and no future edit of the
// default list - can produce a tool-less or read-less request the gate refuses.
const OPENCODE_REQUIRED_TOOL_NAMES = ["read"];

// Operator override for the injected tool list, comma-separated. Invalid names
// are dropped and an override that leaves nothing valid falls back to the
// default list; either way the required name above is present, so a typo can
// never produce a refused request.
export const OPENCODE_PLACEHOLDER_TOOLS_ENV =
  "OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS";

export function openCodeFreeTierPlaceholderTools(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[OPENCODE_PLACEHOLDER_TOOLS_ENV];
  const valid = (typeof raw === "string" ? raw.split(",") : [])
    .map((name) => name.trim())
    .filter((name) => OPENCODE_TOOL_NAME_RE.test(name));
  // `slice` copies, so the module default is never mutated by the unshifts.
  const names = (valid.length ? valid : OPENCODE_PLACEHOLDER_TOOLS).slice(
    0,
    MAX_PLACEHOLDER_TOOLS,
  );
  const missingRequired = OPENCODE_REQUIRED_TOOL_NAMES.filter(
    (name) => !names.includes(name),
  );
  return [...missingRequired, ...names].slice(0, MAX_PLACEHOLDER_TOOLS);
}

export type FreeTierBodyKind = "chat" | "responses";

// --- what got injected, and what the client can actually answer -------------
//
// The gate demands entries named `bash` and `read`, so a request from a client
// that declares its OWN tools (Claude Code's `Bash`/`Read`, an agent's `shell`,
// ...) must carry entries the client never declared - and models call them.
// Neither request-side lever stops that (measured live on the free roster):
// `tool_choice: "none"` was ignored by mimo's upstream in 2/4 runs, and a
// system message declaring the tools unavailable changed nothing. So the plan
// recorded here lets the response side both deliver a call the client CAN
// answer and suppress one it cannot.
export interface OpencodeToolPlan {
  /** The names this gateway added to `tools`. */
  injected: string[];
  /** Injected name -> the CLIENT's own tool it is an alias of (`read` -> `Read`). */
  aliases: Record<string, string>;
  /** Injected names with no client counterpart: their calls are undeliverable. */
  foreign: Record<string, true>;
}

interface ClientToolEntry {
  name: string;
  description: unknown;
  parameters: unknown;
}

// Names already present in a caller-supplied tool list, in either wire shape
// (Chat nests the definition under `function`, Responses puts it flat).
function toolNames(tools: unknown[]): Record<string, true> {
  const names: Record<string, true> = {};
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const entry = tool as Record<string, unknown>;
    const fn = entry.function as Record<string, unknown> | undefined;
    const name = fn?.name ?? entry.name;
    if (typeof name === "string" && name) names[name] = true;
  }
  return names;
}

// The caller's tools as (name, own description, own parameter schema) - the
// material an injected ALIAS borrows so the model calls it with the client's
// argument names instead of the CLI's.
function clientToolEntries(tools: unknown[]): ClientToolEntry[] {
  const entries: ClientToolEntry[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const entry = tool as Record<string, unknown>;
    const fn = entry.function as Record<string, unknown> | undefined;
    const name = fn?.name ?? entry.name;
    if (typeof name !== "string" || !name) continue;
    entries.push({
      name,
      description: fn?.description ?? entry.description,
      parameters: fn?.parameters ?? entry.parameters,
    });
  }
  return entries;
}

// The CLI renamed its shell tool from `bash` to `shell` in 2.0. A client that
// still declares the old name (Claude Code's `Bash`, most integrations) should
// receive the model's `shell` call under that name, with its own schema.
const OPENCODE_TOOL_ALIASES: Record<string, string[]> = {
  shell: ["bash"],
};

// The client tool an injected name stands in for. Case-insensitive, and only
// when it is the ONE match: a client declaring both `Read` and `READ` is left
// alone rather than guessed at. An exact name wins over a legacy alias.
function aliasTarget(
  name: string,
  entries: ClientToolEntry[],
): ClientToolEntry | null {
  const candidates = [name, ...(OPENCODE_TOOL_ALIASES[name] ?? [])];
  for (const candidate of candidates) {
    const matches = entries.filter(
      (entry) => entry.name.toLowerCase() === candidate.toLowerCase(),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

function toolEntry(
  name: string,
  description: unknown,
  parameters: unknown,
  kind: FreeTierBodyKind,
): unknown {
  // The CLI sends `strict: false` on every definition (its OpenAI-compatible
  // lowering always disables strict mode); the free-tier gate accepts either
  // value but the key is part of the captured shape.
  const base = { name, description, parameters, strict: false };
  // Chat Completions nests the definition under `function`; Responses puts it
  // flat on the tool entry.
  return kind === "chat"
    ? { type: "function", function: base }
    : { type: "function", ...base };
}

function placeholderTool(name: string, kind: FreeTierBodyKind): unknown {
  // A default name resolves to the CLI's own captured definition; only an
  // operator-added name (env override) has none to look up.
  const definition = OPENCODE_FREE_TIER_TOOL_DEFINITIONS[name];
  return toolEntry(
    name,
    definition?.description ?? OPENCODE_NEUTRAL_TOOL_DESCRIPTION,
    definition?.parameters ?? { type: "object", properties: {} },
    kind,
  );
}

// The alias: the gate-required lowercase name carrying the CLIENT's own
// description and parameter schema, so a call the model makes is valid against
// the tool the client will actually run.
function aliasedTool(
  name: string,
  target: ClientToolEntry,
  kind: FreeTierBodyKind,
): unknown {
  return toolEntry(
    name,
    target.description ?? OPENCODE_NEUTRAL_TOOL_DESCRIPTION,
    target.parameters ?? { type: "object", properties: {} },
    kind,
  );
}

// The rest of the free-tier body contract, applied on the CLIENT-shaped body
// pre-conversion (Zen gates on the wire body it receives):
//   - `stream: true` unconditionally - the CLI always streams and a buffered
//     request is refused (verified live: the same body with `stream` dropped is
//     a 403);
//   - the CLI's core tools present in `tools` - a tool-less request is refused,
//     and so is one that omits the literal lowercase `read` (see
//     OPENCODE_PLACEHOLDER_TOOLS), so the missing names are MERGED IN.
// Caller entries are never removed, reordered or replaced, so a client's own
// definition always wins. Returns the plan of what was injected (see
// OpencodeToolPlan) for the response side to enforce.
// `tool_choice` is left exactly as the caller wrote it - upstream 400s on
// anything but `"auto"`, so this deliberately never adds one.
// Condition 2's system-prompt half: an `<env>` block in a system message plus
// a `read` tool was measured to be sufficient; values inside the block are not
// checked (a minimal `<env>Working directory: /</env>` passes). Appended as a
// SEPARATE system message AFTER the caller's own system turns, so the caller's
// instructions keep their position, role and precedence. The date is real, like
// the CLI's, so the block never looks stale to a future check.
const OPENCODE_ENV_BLOCK_RE = /<env>[\s\S]*?<\/env>/;

export function openCodeEnvMarker(now: Date = new Date()): string {
  return [
    "<env>",
    "  Working directory: /",
    "  Workspace root folder: /",
    "  Is directory a git repo: no",
    "  Platform: linux",
    `  Today's date: ${now.toDateString()}`,
    "</env>",
  ].join("\n");
}

// Text of a chat message's content, for the marker probe: string content, or
// the concatenated text parts of a multimodal array (what the wire accepts).
function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = (part as Record<string, unknown>)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

// Make sure the free-tier prompt profile carries the `<env>` block. Chat: a
// system message anywhere in the history containing a complete block satisfies
// it (the CLI's agent prompt embeds one, so a client that already forwards an
// OpenCode-shaped prompt is left untouched). Responses: the `instructions`
// field, which is the system prompt on that wire.
function ensureOpenCodeEnvBlock(
  body: Record<string, unknown>,
  kind: FreeTierBodyKind,
): void {
  const marker = openCodeEnvMarker();
  if (kind === "responses") {
    const instructions = body.instructions;
    if (typeof instructions === "string") {
      if (!OPENCODE_ENV_BLOCK_RE.test(instructions))
        body.instructions = `${instructions}\n\n${marker}`;
      return;
    }
    if (instructions === undefined || instructions === null)
      body.instructions = marker;
    return;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  const hasBlock = messages.some(
    (message) =>
      (message as Record<string, unknown>)?.role === "system" &&
      OPENCODE_ENV_BLOCK_RE.test(messageText(message)),
  );
  if (hasBlock) return;
  // Insert after the caller's leading system turns: the marker is context, not
  // an instruction, so it must not displace the caller's own system prompt.
  let at = 0;
  while (
    at < messages.length &&
    (messages[at] as Record<string, unknown>)?.role === "system"
  )
    at++;
  messages.splice(at, 0, { role: "system", content: marker });
}

// The free-tier BODY contract, gated on the request being anonymous + a
// free-tier model. Applied by the adapter's build phase, on the body in the
// PROVIDER's wire format - the body Zen actually gates on. (A request stage
// would run pre-conversion, where a Messages client's body is not yet chat and
// the converter could drop the injected entries; the wire body is the only
// place every client format is covered.)
export function applyOpenCodeFreeTierContract(
  body: Record<string, unknown>,
  kind: FreeTierBodyKind,
  apiKey: string | null | undefined,
  model: string | null | undefined,
): OpencodeToolPlan | null {
  if (!isOpencodeAnonymousKey(apiKey)) return null;
  const id = model ?? (typeof body.model === "string" ? body.model : "");
  if (!isOpencodeFreeTierModel(id)) return null;
  return ensureOpenCodeFreeTierBody(body, kind);
}

export function ensureOpenCodeFreeTierBody(
  body: Record<string, unknown>,
  kind: FreeTierBodyKind,
): OpencodeToolPlan {
  body.stream = true;
  const existing = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const present = toolNames(existing);
  const entries = clientToolEntries(existing);
  const plan: OpencodeToolPlan = { injected: [], aliases: {}, foreign: {} };
  const missing = openCodeFreeTierPlaceholderTools().filter(
    (name) => !present[name],
  );
  if (missing.length > 0) {
    const injected = missing.map((name) => {
      plan.injected.push(name);
      const target = aliasTarget(name, entries);
      if (target) {
        plan.aliases[name] = target.name;
        return aliasedTool(name, target, kind);
      }
      plan.foreign[name] = true;
      return placeholderTool(name, kind);
    });
    body.tools = [...existing, ...injected];
  }
  // A caller with no tools of its own gets a list that is ENTIRELY ours, and a
  // model handed the CLI's real definitions calls them - the `shell` description
  // is an invitation, and the models take it: measured live on the free roster
  // (4 prompts x 2 models, chat), `tool_choice: "auto"` produced a tool call in
  // 4/4 big-pickle runs (even for "capital of France?") and 2/4 mimo runs. A
  // tool-less client cannot answer such a call, so "none" is the one
  // gate-neutral lever we have: it took big-pickle to 0/4. It is a mitigation,
  // not a guarantee - mimo's upstream honoured it only 2/4 - which is exactly
  // why the response-side guard below exists and drops what "none" let through.
  // Chat accepts "none" (verified live, and the gate ignores the field: unset /
  // auto / none / required all answer 200); the Responses endpoint 400s on
  // anything but `"auto"`, so it is never sent there, and a caller that brought
  // its own tools keeps its own choice - forcing "none" there would disable the
  // client's legitimate tool use.
  if (kind === "chat" && existing.length === 0) body.tool_choice = "none";
  // The CLI asks for usage on the streaming response (captured body:
  // `stream_options: {include_usage: true}`), which is what lets a buffered
  // caller of a forced-stream request still be charged the real token counts.
  // Chat-only field; the Responses API reports usage in the terminal event.
  if (kind === "chat") {
    const streamOptions = body.stream_options as
      Record<string, unknown> | undefined;
    body.stream_options = {
      ...(streamOptions && typeof streamOptions === "object"
        ? streamOptions
        : {}),
      include_usage: true,
    };
  }
  ensureOpenCodeEnvBlock(body, kind);
  return plan;
}

// --- response-side guard ----------------------------------------------------
//
// Whatever `tool_choice` did or did not prevent, a client must never receive a
// tool call it cannot answer. The guard runs on the response in the SHAPE the
// provider produced (chat or responses), which lands pre-bridge for a converted
// client format - so one implementation covers chat/messages/responses clients.
//
//   - a call to an ALIASED injected name is renamed back to the client's own
//     spelling (`read` -> `Read`); the arguments already match, because the
//     injected entry carried the client's own schema;
//   - a call to a FOREIGN injected name is DROPPED, with the turn's finish
//     reason downgraded so the client doesn't wait for a tool result;
//   - a call to any other name is the client's own business and passes through.
// Caller-declared tools are never touched, so a legitimate tool call is never
// rewritten on the strength of a name we injected.

const OPENCODE_TOOL_PLAN_KEY = "opencode:injected-tools";
const OPENCODE_STREAM_GUARD_KEY = "opencode:injected-tools:stream";

export function rememberOpencodeToolPlan(
  state: Record<string, unknown> | undefined,
  plan: OpencodeToolPlan,
): void {
  if (state) state[OPENCODE_TOOL_PLAN_KEY] = plan;
}

export function opencodeToolPlanFrom(
  state: Record<string, unknown> | undefined,
): OpencodeToolPlan | null {
  const plan = state?.[OPENCODE_TOOL_PLAN_KEY] as OpencodeToolPlan | undefined;
  return plan && typeof plan === "object" ? plan : null;
}

interface CallDisposition {
  rename?: string;
  drop?: boolean;
}

function dispositionFor(
  name: unknown,
  plan: OpencodeToolPlan,
): CallDisposition {
  if (typeof name !== "string" || !name) return {};
  if (plan.foreign[name]) return { drop: true };
  const alias = plan.aliases[name];
  return alias ? { rename: alias } : {};
}

// Apply the plan to one array of call entries: renaming in place, removing
// foreign ones. Returns the SAME array reference when nothing changed, so a
// caller can skip work (and leave a response byte-identical) when the model
// called only the client's own tools.
function applyToolPlan<C>(
  calls: C[],
  plan: OpencodeToolPlan,
  nameOf: (call: C) => { at: Record<string, unknown>; name: unknown } | null,
): C[] {
  let changed = false;
  const kept: C[] = [];
  for (const call of calls) {
    const found = nameOf(call);
    const disposition = dispositionFor(found?.name, plan);
    if (disposition.drop) {
      changed = true;
      continue;
    }
    if (disposition.rename && found) {
      found.at.name = disposition.rename;
      changed = true;
    }
    kept.push(call);
  }
  return changed ? kept : calls;
}

function guardChatToolCalls(
  body: Record<string, unknown>,
  plan: OpencodeToolPlan,
): void {
  const choices = body.choices;
  if (!Array.isArray(choices)) return;
  for (const raw of choices) {
    const choice = raw as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    const calls = message?.tool_calls;
    if (!message || !Array.isArray(calls)) continue;
    const kept = applyToolPlan(calls, plan, (call) => {
      const fn = (call as Record<string, unknown>).function as
        Record<string, unknown> | undefined;
      return fn ? { at: fn, name: fn.name } : null;
    });
    if (kept === calls) continue;
    if (kept.length > 0) message.tool_calls = kept;
    else {
      delete message.tool_calls;
      if (choice.finish_reason === "tool_calls") choice.finish_reason = "stop";
    }
  }
}

function guardResponsesToolCalls(
  body: Record<string, unknown>,
  plan: OpencodeToolPlan,
): void {
  const output = body.output;
  if (!Array.isArray(output)) return;
  const kept = applyToolPlan(output, plan, (item) => {
    const it = item as Record<string, unknown>;
    return it.type === "function_call" ? { at: it, name: it.name } : null;
  });
  if (kept !== output) body.output = kept;
}

export function guardOpenCodeInjectedToolCalls(
  body: Record<string, unknown>,
  shape: FreeTierBodyKind,
  plan: OpencodeToolPlan,
): void {
  if (shape === "chat") guardChatToolCalls(body, plan);
  else guardResponsesToolCalls(body, plan);
}

// --- streaming guard --------------------------------------------------------
//
// A streamed call announces its NAME in one delta and then dribbles its
// arguments across later ones, which is why the shape is tracked per call index:
// aliased calls are renamed as they are announced (their arguments already fit
// the client's schema, so the fragments need no rewriting), and a foreign call
// is dropped together with every argument fragment that follows it.

interface StreamGuardState {
  dropped: Record<number, true>;
  kept: Record<number, true>;
}

function streamGuardState(
  state: Record<string, unknown> | undefined,
): StreamGuardState {
  if (!state) return { dropped: {}, kept: {} };
  const existing = state[OPENCODE_STREAM_GUARD_KEY] as
    StreamGuardState | undefined;
  if (existing) return existing;
  const fresh: StreamGuardState = { dropped: {}, kept: {} };
  state[OPENCODE_STREAM_GUARD_KEY] = fresh;
  return fresh;
}

export function guardOpenCodeChatStreamEvent(
  event: Record<string, unknown>,
  plan: OpencodeToolPlan,
  state: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const guard = streamGuardState(state);
  const choices = event.choices;
  if (!Array.isArray(choices)) return event;
  let touched = false;
  for (const raw of choices) {
    const choice = raw as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;
    const calls = delta?.tool_calls;
    if (delta && Array.isArray(calls)) {
      const kept: unknown[] = [];
      for (const rawCall of calls) {
        const call = rawCall as Record<string, unknown>;
        const index = typeof call.index === "number" ? call.index : 0;
        if (guard.dropped[index]) {
          touched = true;
          continue;
        }
        const fn = call.function as Record<string, unknown> | undefined;
        const disposition = dispositionFor(fn?.name, plan);
        if (disposition.drop) {
          guard.dropped[index] = true;
          touched = true;
          continue;
        }
        if (disposition.rename && fn) {
          fn.name = disposition.rename;
          touched = true;
        }
        guard.kept[index] = true;
        kept.push(rawCall);
      }
      if (touched) {
        if (kept.length > 0) delta.tool_calls = kept;
        else delete delta.tool_calls;
      }
    }
    // Every announced call was ours and undeliverable: the turn ends as an
    // ordinary stop instead of a tool_calls turn nobody can answer.
    if (
      choice.finish_reason === "tool_calls" &&
      Object.keys(guard.kept).length === 0
    ) {
      choice.finish_reason = "stop";
      touched = true;
    }
  }
  if (!touched) return event;
  // An event that carried nothing but a dropped call's deltas disappears
  // entirely - an empty `delta` would otherwise still be a visible chunk.
  const emptied = choices.every((raw) => {
    const delta = (raw as Record<string, unknown>).delta as
      Record<string, unknown> | undefined;
    return !delta || Object.keys(delta).length === 0;
  });
  return emptied ? null : event;
}

export function guardOpenCodeResponsesStreamEvent(
  event: Record<string, unknown>,
  plan: OpencodeToolPlan,
  state: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const guard = streamGuardState(state);
  // The call is announced whole (`response.output_item.added`), so a decision is
  // made once and remembered by output index: its argument deltas (and its
  // completion event) then follow the same fate.
  const item = event.item as Record<string, unknown> | undefined;
  const index = typeof event.output_index === "number" ? event.output_index : 0;
  if (item && item.type === "function_call") {
    const disposition = dispositionFor(item.name, plan);
    if (disposition.drop) {
      guard.dropped[index] = true;
      if (event.type === "response.output_item.done") guard.kept[index] = true;
      return null;
    }
    if (disposition.rename) item.name = disposition.rename;
    guard.kept[index] = true;
    return event;
  }
  if (event.type === "response.function_call_arguments.delta") {
    if (guard.dropped[index]) return null;
    if (typeof event.item_id === "string") {
      // Delivered arguments are fine as-is: the alias carried the client schema.
    }
    return event;
  }
  if (
    event.type === "response.incomplete" ||
    event.type === "response.completed"
  ) {
    if (Object.keys(guard.kept).length === 0) event.type = "response.completed";
  }
  return event;
}

// Zen's free tier is a rotating roster: every current free model carries the
// `-free` suffix (deepseek-v4.1-flash-free, glm-5.3-flash-free,
// mimo-v2.6-flash-free, nemotron-3.5-{lightning,super-vl}-free, beam-free,
// flint-40b-free, jev-1.13-free, ...), so the suffix rule follows rotations
// without a deploy. The table holds the exceptions upstream ships WITHOUT the
// suffix - currently only the stealth `big-pickle`. An unknown non-suffixed id
// is treated as PAID (fail-safe: a paid key keeps the caller's body verbatim
// and needs neither the markers nor the custom transport).
const OPENCODE_FREE_TIER_MODELS: Record<string, true> = {
  "big-pickle": true,
};

export function isOpencodeFreeTierModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (!id) return false;
  return id.endsWith("-free") || OPENCODE_FREE_TIER_MODELS[id] === true;
}

// Anonymous free-tier requests must present the CLI's ClientHello (see the
// module header), which Node's own TLS cannot emit. The engine routes exactly
// these attempts through src/providers/opencode-tls; a real Zen key or a paid model
// keeps the plain Node path, value-for-value unchanged.
export function needsOpenCodeFreeTierTransport(
  catalogId: string | null | undefined,
  apiKey: string | null | undefined,
  model: string,
): boolean {
  return (
    catalogId === "opencode" &&
    isOpencodeAnonymousKey(apiKey) &&
    isOpencodeFreeTierModel(model)
  );
}

// Zen's free-tier refusal: a 403/451 FreeTierError or a 429 FreeUsageLimitError
// whose body names the gate. The gate now rejects on transport (ClientHello)
// and prompt profile, and reports that as "free usage limit reached", so a 429
// carrying FreeUsageLimitError is the same request-level verdict - not a dead
// credential and not a transient rate limit worth retrying (an identical retry
// gets an identical answer; the anonymous `public` key is still usable).
export function isOpencodeFreeTierRefusal(
  status: number,
  bodyText: string | null | undefined,
): boolean {
  if (status !== 403 && status !== 429 && status !== 451) return false;
  if (typeof bodyText !== "string" || !bodyText) return false;
  const text = bodyText.toLowerCase();
  return (
    text.includes("freetiererror") ||
    text.includes("freeusagelimiterror") ||
    text.includes("free tier can only be used") ||
    text.includes("free models aren't available") ||
    text.includes("free usage limit")
  );
}

interface AttributionOptions {
  // Endpoint-specific CLI user agent; defaults to the chat/messages one.
  userAgent?: string;
  // Force the anonymous free-tier identity (`authorization: Bearer public`),
  // overwriting whatever the engine derived. Only the Zen adapter sets this:
  // OpenCode Go has no anonymous tier, so a missing key there must stay
  // missing (and the failure honest) rather than becoming `public`.
  anonymousAuth?: boolean;
  // Mint fresh, single-request ids (session descending, request ascending)
  // instead of honoring a caller id or a cached per-conversation one. Set for
  // anonymous free-tier requests, whose allowance is spent per session id.
  freshIds?: boolean;
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
  // Session: a caller value is honoured only when it has the CLI's shape AND a
  // clock value the gate still accepts, and only outside the free tier - a
  // free-tier allowance is spent per session id, so those requests always get
  // a brand-new one. Otherwise derive from the body's conversation identity,
  // else the cached fallback.
  if (options.freshIds) {
    session = mintOpenCodeId("ses_", true);
  } else if (
    !session ||
    !OPENCODE_SESSION_ID_RE.test(session) ||
    !isFreshOpenCodeId(session)
  ) {
    session =
      openCodeSessionFromBody(body) ??
      openCodeId("ses_", OPENCODE_FALLBACK_SEED);
  }
  // Request: caller value in the CLI's shape wins (the CLI puts its message id
  // here); else a deterministic per-conversation id, seeded so it never
  // collides with the session.
  if (options.freshIds) {
    // The CLI's request ids are `Identifier.ascending` (raw clock), unlike the
    // descending session ids.
    request = mintOpenCodeId("msg_", false);
  } else if (
    !request ||
    !OPENCODE_REQUEST_ID_RE.test(request) ||
    !isFreshOpenCodeId(request)
  ) {
    request = deterministicOpenCodeCodeRequestId(body, session);
  }

  const out: Record<string, string> = { ...headers };
  for (const key of Object.keys(out)) {
    if (OWNED_HEADERS.includes(key.toLowerCase())) delete out[key];
  }
  // The CLI identifies one session under four names: its real id, the affinity
  // it shares with a parent/fork, and the two aliases older clients read.
  out[OPENCODE_SESSION_HEADER] = session;
  out[OPENCODE_SESSION_ID_HEADER] = session;
  out[OPENCODE_AFFINITY_HEADER] = session;
  out[OPENCODE_SESSION_ID_ALIAS_HEADER] = session;
  out[OPENCODE_REQUEST_HEADER] = request;
  out[OPENCODE_CLIENT_HEADER] = OPENCODE_CLIENT;
  out[OPENCODE_PROJECT_HEADER] = project ?? OPENCODE_DEFAULT_PROJECT;
  // OpenCode's own UA, unless the caller already set one that satisfies the
  // gate's CLI version contract. A stale/foreign UA (a bare `curl/8.5.0`, an
  // old integrating client) is REPLACED rather than forwarded into a refusal -
  // the same treatment the owned headers get.
  const userAgent = options.userAgent ?? OPENCODE_USER_AGENT;
  let hasContractualUserAgent = false;
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() !== "user-agent") continue;
    if (satisfiesOpencodeUserAgentContract(out[key]))
      hasContractualUserAgent = true;
    else delete out[key];
  }
  if (!hasContractualUserAgent) out["user-agent"] = userAgent;
  // Anonymous caller: claim the CLI's own free-tier identity, replacing the
  // engine-derived auth header (which is either absent or the client's own
  // gateway bearer - never a key Zen would accept).
  if (options.anonymousAuth) {
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === "authorization") delete out[key];
    }
    out["authorization"] = `Bearer ${OPENCODE_ANONYMOUS_KEY}`;
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
  return openCodeId("msg_", `${identity}:request`);
}
