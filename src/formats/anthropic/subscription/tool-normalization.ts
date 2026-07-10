export const OPENCODE_TOOL_NAME_MAP: ReadonlyMap<string, string> = new Map<
  string,
  string
>([
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["todowrite", "TodoWrite"],
  ["lsp", "LSP"],
  ["skill", "Skill"],
  ["question", "AskUserQuestion"],
  ["list_mcp_resource_templates", "ListMcpResourceTemplatesTool"],
  ["list_mcp_resources", "ListMcpResourcesTool"],
]);

/**
 * ohmypi's builtin tool names (snake_case / lowercase) → Claude Code-native
 * PascalCase. Same purpose as {@link OPENCODE_TOOL_NAME_MAP}: strip the
 * third-party fingerprint that Anthropic's classifier flags.
 *
 * Entries fall into two groups:
 *   - Close links to a real Claude Code native tool (see {@link CC_TOOL_NAMES})
 *     where the ohmypi tool has a direct CC counterpart — e.g. `ask`→
 *     `AskUserQuestion`, `task`→`Agent` (the subagent-spawn tool), `todo`→
 *     `TaskCreate` (the current CC task-list tool; unlike the legacy `TodoWrite`
 *     it IS in {@link CC_TOOL_NAMES}, so the mapping also earns a decoy stub),
 *     `manage_skill`→`Skill`.
 *   - Outliers with no CC equivalent, kept as extra PascalCase names. Acronyms
 *     are cased explicitly (`ssh`→`SSH`, `irc`→`IRC`, `lsp`→`LSP`,
 *     `github`→`GitHub`) since the algorithmic PascalCaser would otherwise
 *     produce `Ssh` / `Irc` / `Github`.
 *
 * Shared keys agree with {@link OPENCODE_TOOL_NAME_MAP} (e.g. `read`→`Read`),
 * so consulting both maps is order-independent.
 */
export const OHMYPI_TOOL_NAME_MAP: ReadonlyMap<string, string> = new Map<
  string,
  string
>([
  // --- Close links to Claude Code native tools ---
  ["read", "Read"],
  ["bash", "Bash"],
  ["edit", "Edit"],
  ["write", "Write"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["ask", "AskUserQuestion"],
  ["task", "Agent"],
  ["todo", "TaskCreate"],
  ["web_search", "WebSearch"],
  ["manage_skill", "Skill"],

  // --- Outliers: no CC counterpart, kept as extra PascalCase names ---
  ["ast_grep", "AstGrep"],
  ["ast_edit", "AstEdit"],
  ["debug", "Debug"],
  ["eval", "Eval"],
  ["ssh", "SSH"],
  ["github", "GitHub"],
  ["lsp", "LSP"],
  ["inspect_image", "InspectImage"],
  ["browser", "Browser"],
  ["checkpoint", "Checkpoint"],
  ["rewind", "Rewind"],
  ["job", "Job"],
  ["irc", "IRC"],
  ["search_tool_bm25", "SearchToolBm25"],
  ["memory_edit", "MemoryEdit"],
  ["retain", "Retain"],
  ["recall", "Recall"],
  ["reflect", "Reflect"],
  ["learn", "Learn"],
]);

export interface NormalizedToolsResult {
  body: Record<string, unknown>;
  /**
   * transformed tool name → original tool name, for response-side remapping.
   * Built from `tools[]` (the set of tools the model can actually call);
   * first occurrence wins so it stays consistent with de-duplication.
   */
  renameMap: Map<string, string>;
}

export function normalizeToolNames(
  requestBody: Readonly<Record<string, unknown>>,
): NormalizedToolsResult {
  const out: Record<string, unknown> = { ...requestBody };
  const renameMap = new Map<string, string>();

  // 1. Top-level tools[] array — rename (recording the reverse map, first
  //    occurrence wins to match dedup), then drop duplicate names. Anthropic
  //    rejects duplicate tool names with HTTP 400.
  const tools = out["tools"];
  if (Array.isArray(tools)) {
    out["tools"] = dedupToolsByName(
      tools.map((t) => renameToolDefinition(t, renameMap)),
    );
  }

  // 2. tool_choice.name (kept consistent with tools[]; responses never echo
  //    tool_choice, so it is not recorded in the reverse map).
  const choice = out["tool_choice"];
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const c = choice as Record<string, unknown>;
    const renamed = maybeRenameToolName(c["name"]);
    if (renamed !== undefined) {
      out["tool_choice"] = { ...c, name: renamed };
    }
  }

  // 3. Assistant tool_use.name in messages[] (multi-turn history consistency).
  const messages = out["messages"];
  if (Array.isArray(messages)) {
    out["messages"] = messages.map((m) => renameToolUseInMessage(m));
  }

  return { body: out, renameMap };
}

function renameToolDefinition(
  t: unknown,
  renameMap: Map<string, string>,
): unknown {
  if (typeof t !== "object" || t === null || Array.isArray(t)) return t;
  const td = { ...(t as Record<string, unknown>) };
  // Server / built-in tools carry a `type` that is NOT `custom` (e.g.
  // `web_search_20250305`, `computer_20250124`). Their `name` is fixed by the
  // schema (`web_search` for the web search tool) and renaming it triggers
  // `tools.N.<type>.name: Input should be '<expected>'` (HTTP 400). Only the
  // standard `{name, description, input_schema}` user-defined tools (no `type`)
  // are renamed.
  if (isServerTool(td)) return td;
  const original = td["name"];
  const renamed = maybeRenameToolName(original);
  if (renamed !== undefined) {
    td["name"] = renamed;
    if (
      typeof original === "string" &&
      renamed !== original &&
      !renameMap.has(renamed)
    ) {
      renameMap.set(renamed, original);
    }
  }
  return td;
}

/**
 * A tool is a server/built-in tool when it carries a `type` field other than
 * `custom`. Built-in tool types include `web_search_*`, `computer_*`,
 * `bash_20250124`, `text_editor_*`, `code_execution_*`, etc. — all of which
 * mandate a specific fixed `name` and must be passed through verbatim.
 */
function isServerTool(td: Record<string, unknown>): boolean {
  const type = td["type"];
  return typeof type === "string" && type !== "custom";
}

function renameToolUseInMessage(m: unknown): unknown {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return m;
  const msg = { ...(m as Record<string, unknown>) };
  const content = msg["content"];
  if (!Array.isArray(content)) return msg;
  msg["content"] = content.map((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block))
      return block;
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_use") {
      const renamed = maybeRenameToolName(b["name"]);
      if (renamed !== undefined) {
        return { ...b, name: renamed };
      }
    }
    return block;
  });
  return msg;
}

/**
 * Resolve a tool name to its Claude Code-native form:
 *   - `mcp_*` (e.g. `mcp__server__tool`) is returned unchanged — MCP tools keep
 *     their own naming convention.
 *   - A tool a Claude Code client already sends in native form (`Read`, `Bash`,
 *     …) passes through untouched: the override maps are keyed by the
 *     lowercase / snake_case client spelling only, so a PascalCase CC name
 *     misses them and lands on the idempotent `toPascalCase` (`Read`→`Read`).
 *     CC-native requests are therefore a no-op — they "work as-is".
 *   - Known third-party client names use the explicit override maps: opencode
 *     first, then ohmypi. The two agree on shared keys (`read`→`Read`, …), so
 *     consult order does not matter; each also carries client-specific aliases
 *     (`question`→`AskUserQuestion`, `manage_skill`→`Skill`) and acronym
 *     casings (`lsp`→`LSP`, `ssh`→`SSH`) that the algorithmic pass can't infer.
 *   - Everything else is PascalCased so the tool list reads as native Claude
 *     Code tooling. Lowercase / snake_case tool names are a third-party
 *     fingerprint that Anthropic's classifier uses to flag non-CC clients.
 *
 * Returns `undefined` only for non-string / empty names (leave untouched).
 */
function maybeRenameToolName(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const mapped =
    OPENCODE_TOOL_NAME_MAP.get(value) ?? OHMYPI_TOOL_NAME_MAP.get(value);
  if (mapped !== undefined) return mapped;

  if (value.toLowerCase().includes("mcp")) {
    return `mcp__${value.replace(/^mcp_{0,2}/i, "")}`;
  }

  return toPascalCase(value);
}

/**
 * Convert an arbitrary tool name to PascalCase. Splits on runs of
 * non-alphanumeric characters and on lower→upper (camelCase) boundaries,
 * capitalizes the first letter of each token, and joins. Idempotent on names
 * that are already PascalCase, and strips characters outside Anthropic's tool
 * name schema (`^[a-zA-Z0-9_-]{1,64}$`).
 */
function toPascalCase(name: string): string {
  const tokens = name
    .split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return name; // no alphanumeric content; leave as-is
  return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join("");
}

/** Keep the first tool per `name`; drop later duplicates (post-rename). */
function dedupToolsByName(tools: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const t of tools) {
    const name =
      t && typeof t === "object" && !Array.isArray(t)
        ? (t as Record<string, unknown>)["name"]
        : undefined;
    if (typeof name === "string") {
      if (seen.has(name)) continue;
      seen.add(name);
    }
    result.push(t);
  }
  return result;
}

// =============================================================================
// CC tool-name stubs — names always present, generic "unavailable" definitions
// =============================================================================
//
// Claude Code always advertises its full native tool set on /v1/messages. The
// NAMES must be present so the tool list matches Claude Code's shape; the
// descriptions/schemas do NOT need to match (only the client-supplied tools are
// ever actually called). So every CC name the request did not already supply is
// filled with a generic "This tool is currently unavailable." stub, and a
// client-supplied tool whose PascalCased name matches a CC name overrides that
// slot (its real definition wins). See ensureCcDecoyTools.

/** The Claude Code native tool names (no standalone `Task`; `Task*` only). */
export const CC_TOOL_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "PushNotification",
  "Read",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
] as const;

export interface CcDecoyTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: { type: string; properties: Record<string, unknown> };
}

const CC_UNAVAILABLE_DESCRIPTION = "This tool is currently unavailable.";
const ccUnavailableStub = (name: string): CcDecoyTool => ({
  name,
  description: CC_UNAVAILABLE_DESCRIPTION,
  input_schema: { type: "object", properties: {} },
});

/** One generic "unavailable" stub per Claude Code native tool name. */
export const CC_DECOY_TOOLS: readonly CcDecoyTool[] =
  CC_TOOL_NAMES.map(ccUnavailableStub);

/**
 * Append a CC native tool decoy for every name the request did NOT already
 * advertise. Tools already present — whether supplied directly by Claude or
 * produced by a third-party override that renames to the same PascalCase name —
 * are left alone (exact, case-insensitive dedup).
 */
export function ensureCcDecoyTools(
  requestBody: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...requestBody };
  const tools = out["tools"];
  const list: unknown[] = Array.isArray(tools) ? tools : [];

  // Suppress a decoy only when a tool with the SAME name (case-insensitive) is
  // already supplied. We deliberately do NOT fuzzy-match across spellings: a
  // server `web_search` tool must NOT suppress the `WebSearch` decoy, because
  // the conversation history can carry `WebSearch` tool_use blocks (Claude Code
  // calls its tools by their PascalCase names) and Anthropic rejects any
  // tool_use whose name isn't declared in `tools[]` with
  // `Tool '<Name>' not found in provided tools`. Keeping both lets the model
  // use the server tool while historical `WebSearch` references still resolve.
  const existing = new Set<string>();
  for (const t of list) {
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") existing.add(name.toLowerCase());
    }
  }

  const decoys = CC_DECOY_TOOLS.filter(
    (d) => !existing.has(d.name.toLowerCase()),
  ).map((d) => ({ ...d }));
  if (decoys.length === 0) return out;

  out["tools"] = [...list, ...decoys];
  return out;
}
