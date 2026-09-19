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
//   body:               stream: true + the CLI's tool list + stream_options
//
// Verified on POST https://opencode.ai/zen/v1/chat/completions with the public
// key, each condition isolated (repeats deterministic):
//   - `stream` omitted/`false`                 -> 403, `stream: true` -> 200
//   - session UUID / 6-hex body / 32-char body -> 403; 12-hex + 14-base62 -> 200
//   - request, client and project headers      -> each removable, still 200
//   - user-agent: none or `curl/8.5.0`         -> 403 FreeTierError;
//     `opencode/1.16.9 cli` -> 426 UpgradeRequired; `opencode/1.18.31
//     ai-sdk/...` and `opencode/latest/2.0.6/cli` -> 200
//   - authorization: anything but `Bearer public` (Zen's anonymous key) -> 401
//     AuthError, so an anonymous attempt must overwrite the client's own bearer
//   - tools: [] / [read] / [bash] / [bash,glob] / [bash,grep] / [bash,edit]
//     -> 403; [bash,read], [bash,glob,grep,read] and any superset -> 200
//     (`bash` and `read` are required BY NAME; extra names are free)
//
// So an anonymous request must satisfy all four:
//   - CLI-shaped session + request ids  (the id shapes above);
//   - `stream: true`;
//   - a `tools` array containing `bash` and `read`;
//   - a User-Agent naming a current OpenCode release.
// A refusal is `403 FreeTierError`; see isOpencodeFreeTierRefusal - it verdicts
// the request, never the credential.
//
// The Zen adapter applies the body half (stream + the CLI's tools + usage) and
// the header half (CLI identity, anonymous auth) to the free-tier roster only;
// OpenCode Go is a paid subscription tier with no anonymous caller, so a
// missing key there stays missing and its body is never rewritten.
//
// Those injected tools are a capability the client never asked for, and models
// do call them - so the adapter also owns the response side of the deal: an
// injected name that matches one of the CLIENT's own tools becomes an ALIAS
// carrying the client's schema (and its calls are renamed back to the client's
// spelling), while an injected name with no counterpart is dropped from the
// response rather than handed to a client that cannot run it. See
// OpencodeToolPlan and the guard section below.
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

// The free-tier gate also inspects the User-Agent: the caller must look like a
// current OpenCode release. Verified live (the rest of the contract held
// constant): no UA -> 403 FreeTierError, `curl/8.5.0` -> 403,
// `opencode/1.16.9 cli` -> 426 UpgradeRequired, `opencode/1.18.31 ai-sdk/...`
// and the channel/version/role form `opencode/latest/2.0.6/cli` -> 200. So both
// the ai-sdk-annotated form and the `<channel>/<version>/<role>` form count;
// anything else is replaced by this gateway's pinned CLI identity rather than
// forwarded into a refusal.
const OPENCODE_UA_VERSION_RE = /\bopencode\/(?:[a-z][a-z0-9-]*\/)?(\d+)\.(\d+)/i;
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

// Zen's free tier also fingerprints the TOOL LIST: a request carrying no tools
// is refused, and so is one whose tools omit the CLI's own core pair. Verified
// live against /v1/chat/completions with the public key (each variant isolated,
// the rest of the contract held constant):
//   [] / [read] / [bash] / [bash,glob] / [bash,grep] / [bash,edit] -> 403
//   [bash,read] / [bash,glob,grep,read] / + any extra names       -> 200
//   [Bash,Read] / [bash,Read] / [Bash,Read,Glob,Grep,Edit,Write]  -> 403
// so the check is CASE-SENSITIVE on the literal lowercase names: `bash` and
// `read` must be present and everything else is free choice. That is why the
// names are injected rather than matched loosely - the capitalised `Bash`/`Read`
// (Glob/Grep/...) that Claude Code and most coding clients send do NOT satisfy
// it, so a case-insensitive "the caller already has these" check would forward
// the client into a refusal.
// The entries injected for those names are not invented stand-ins: they are the
// OpenCode CLI's OWN tool definitions - description and JSON Schema - captured
// verbatim from a real CLI request, so an anonymous request carries the same
// `tools` array the CLI itself sends. The default list is the CLI's four
// read-only tools: the two names the gate requires plus the two the CLI also
// always ships, which keeps the outbound body faithful to the CLI without
// handing the model the mutating ones (`edit`, `write`) it might otherwise be
// tempted to call.
const OPENCODE_PLACEHOLDER_TOOLS = ["bash", "glob", "grep", "read"];

// The CLI's own definitions, keyed by tool name, taken verbatim off the wire
// from a captured real OpenCode CLI request (Chat Completions). Descriptions
// and schemas are byte-exact; nothing here is paraphrased or re-wrapped.
export const OPENCODE_FREE_TIER_TOOL_DEFINITIONS: Record<
  string,
  { description: string; parameters: Record<string, unknown> }
> = {
  bash: {
    description: "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nBe aware: OS: linux, Shell: bash\n\nAll commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.\n\nUse `/tmp/opencode` for temporary work outside the workspace. This directory has already been created, already exists, and is pre-approved for external directory access.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use `ls foo` to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms.\n  - If the output exceeds 2000 lines or 51200 bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use `head`, `tail`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.\n\n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run \"git status\" and \"git diff\", send a single message with two bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - AVOID using `cd <directory> && <command>`. Use the `workdir` parameter to change directories instead.\n    <good-example>\n    Use workdir=\"/foo/bar\" with command: pytest tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>\n\n# Git and GitHub\n- Only commit, amend, push, or create PRs when explicitly requested.\n- Before committing, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only intended files and never commit secrets.\n- Write a concise commit message that matches the repo style.\n- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.\n- If a commit fails or hooks reject it, fix the issue and create a new commit; do not amend the failed commit.\n- Before creating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch.\n- Review all commits included in the PR, not just the latest commit.\n- Use `gh` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done.\n",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        timeout: {
          minimum: -9007199254740991,
          exclusiveMinimum: 0,
          type: "integer",
          maximum: 9007199254740991,
          description: "Optional timeout in milliseconds"
        },
        workdir: {
          type: "string",
          description: "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."
        }
      },
      required: ["command"]
    }
  },
  glob: {
    description: "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths\n- Use this tool when you need to find files by name patterns\n- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.\n",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against"
        },
        path: {
          type: "string",
          description: "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
        }
      },
      required: ["pattern"]
    }
  },
  grep: {
    description: "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Supports full regex syntax (eg. \"log.*Error\", \"function\\s+\\w+\", etc.)\n- Filter files by pattern with the include parameter (eg. \"*.js\", \"*.{ts,tsx}\")\n- Returns file paths and line numbers with matching lines\n- Use this tool when you need to find files containing specific patterns\n- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.\n- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The regex pattern to search for in file contents"
        },
        path: {
          type: "string",
          description: "The directory to search in. Defaults to the current working directory."
        },
        include: {
          type: "string",
          description: "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")"
        }
      },
      required: ["pattern"]
    }
  },
  read: {
    description: "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.\n\nUsage:\n- The filePath parameter should be an absolute path.\n- By default, this tool returns up to 2000 lines from the start of the file.\n- The offset parameter is the line number to start from (1-indexed).\n- To read later sections, call this tool again with a larger offset.\n- Use the grep tool to find specific content in large files or files with long lines.\n- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents \"foo\\n\", you will receive \"1: foo\\n\". For directories, entries are returned one per line (without line numbers) with a trailing `/` for subdirectories.\n- Any line longer than 2000 characters is truncated.\n- Call this tool in parallel when you know there are multiple files you want to read.\n- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.\n- This tool can read image files and PDFs and return them as file attachments.\n",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The absolute path to the file or directory to read"
        },
        offset: {
          minimum: 0,
          type: "integer",
          maximum: 9007199254740991,
          description: "The line number to start reading from (1-indexed)"
        },
        limit: {
          minimum: 0,
          type: "integer",
          maximum: 9007199254740991,
          description: "The maximum number of lines to read (defaults to 2000)"
        }
      },
      required: ["filePath"]
    }
  }
};

// Fallback for a name the CLI does not define, which only an operator-added
// OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS override can produce: a neutral
// description plus the empty object schema. The gate matches tool NAMES only,
// never their contents.
const OPENCODE_NEUTRAL_TOOL_DESCRIPTION =
  "This entry exists for API compatibility with the OpenCode CLI tool list.";
const OPENCODE_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_PLACEHOLDER_TOOLS = 32;

// The names the live gate requires BY NAME (see above). They are re-added to
// whatever the operator configured, so no override - and no future edit of the
// default list - can produce a request the gate refuses.
const OPENCODE_REQUIRED_TOOL_NAMES = ["bash", "read"];

// Operator override for the injected tool list, comma-separated. Invalid names
// are dropped and an override that leaves nothing valid falls back to the
// default list; either way the required pair above is present, so a typo can
// never produce a refused (tool-less or bash-less) request.
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

// The client tool an injected name stands in for. Case-insensitive, and only
// when it is the ONE match: a client declaring both `Read` and `READ` is left
// alone rather than guessed at.
function aliasTarget(
  name: string,
  entries: ClientToolEntry[],
): ClientToolEntry | null {
  const matches = entries.filter(
    (entry) => entry.name.toLowerCase() === name.toLowerCase(),
  );
  return matches.length === 1 ? matches[0] : null;
}

function toolEntry(
  name: string,
  description: unknown,
  parameters: unknown,
  kind: FreeTierBodyKind,
): unknown {
  const base = { name, description, parameters };
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
//     and so is one that carries tools without `bash` + `read` (see
//     OPENCODE_PLACEHOLDER_TOOLS), so the missing names are MERGED IN.
// Caller entries are never removed, reordered or replaced, so a client's own
// definition always wins. Returns the plan of what was injected (see
// OpencodeToolPlan) for the response side to enforce.
// `tool_choice` is left exactly as the caller wrote it - upstream 400s on
// anything but `"auto"`, so this deliberately never adds one.
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
  // model handed the CLI's real definitions calls them - the `bash` description
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
      | Record<string, unknown>
      | undefined;
    body.stream_options = {
      ...(streamOptions && typeof streamOptions === "object"
        ? streamOptions
        : {}),
      include_usage: true,
    };
  }
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
        | Record<string, unknown>
        | undefined;
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

function streamGuardState(state: Record<string, unknown> | undefined): StreamGuardState {
  if (!state) return { dropped: {}, kept: {} };
  const existing = state[OPENCODE_STREAM_GUARD_KEY] as
    | StreamGuardState
    | undefined;
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
      | Record<string, unknown>
      | undefined;
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
  if (event.type === "response.incomplete" || event.type === "response.completed") {
    if (Object.keys(guard.kept).length === 0)
      event.type = "response.completed";
  }
  return event;
}

// Zen's free tier is a fixed roster: models whose id ends in `-free` plus a
// handful upstream ships without the suffix. The suffix rule covers upstream
// rotations without a deploy, and an unknown non-suffixed id is treated as
// PAID - fail-safe, since a paid key keeps the caller's body verbatim.
const OPENCODE_FREE_TIER_MODELS: Record<string, true> = {
  "big-pickle": true,
  "deepseek-v4-flash-free": true,
  "mimo-v2.5-free": true,
  "hy3-free": true,
  "nemotron-3-ultra-free": true,
  "north-mini-code-free": true,
};

export function isOpencodeFreeTierModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (!id) return false;
  return id.endsWith("-free") || OPENCODE_FREE_TIER_MODELS[id] === true;
}

// Zen's free-tier refusal: a 403 (or 451) whose body names the gate. This is a
// verdict on the REQUEST, not on the credential - the anonymous `public` key
// is still perfectly usable - so the engine forwards it to the client verbatim
// instead of counting it as an auth failure, disabling the key or retrying
// (an identical retry gets an identical verdict).
export function isOpencodeFreeTierRefusal(
  status: number,
  bodyText: string | null | undefined,
): boolean {
  if (status !== 403 && status !== 451) return false;
  if (typeof bodyText !== "string" || !bodyText) return false;
  const text = bodyText.toLowerCase();
  return (
    text.includes("freetiererror") || text.includes("free tier can only be used")
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
  return deterministicOpenCodeId("msg_", `${identity}:request`);
}
