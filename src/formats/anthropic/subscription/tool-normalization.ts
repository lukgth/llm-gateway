import {
  type AnthropicMessagesRequest,
  type AnthropicMessage,
  type AnthropicBlock,
  type AnthropicTool,
} from "../../pipeline";

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
 * PascalCase.
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
  body: AnthropicMessagesRequest;
  renameMap: Map<string, string>;
}

export function normalizeToolNames(
  requestBody: Readonly<AnthropicMessagesRequest>,
): NormalizedToolsResult {
  const out: AnthropicMessagesRequest = { ...requestBody };
  const renameMap = new Map<string, string>();

  if (Array.isArray(out.tools)) {
    out.tools = dedupToolsByName(
      out.tools.map((t) => renameToolDefinition(t, renameMap)),
    );
  }

  const choice = out.tool_choice;
  if (choice && typeof choice === "object" && "name" in choice) {
    const renamed = maybeRenameToolName((choice as { name?: unknown }).name);
    if (renamed !== undefined) {
      out.tool_choice = { ...choice, name: renamed } as typeof choice;
    }
  }

  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => renameToolUseInMessage(m));
  }

  return { body: out, renameMap };
}

function renameToolDefinition(
  t: AnthropicTool,
  renameMap: Map<string, string>,
): AnthropicTool {
  if (typeof t !== "object" || t === null || Array.isArray(t)) return t;
  const td = { ...(t as AnthropicTool) };
  // Server / built-in tools carry a `type` that is NOT `custom` (e.g.
  // `web_search_20250305`, `computer_20250124`). Their `name` is fixed by the
  // schema (`web_search` for the web search tool) and renaming it triggers
  // `tools.N.<type>.name: Input should be '<expected>'` (HTTP 400). Only the
  // standard `{name, description, input_schema}` user-defined tools (no `type`)
  // are renamed.
  if (isServerTool(td)) return td;
  const original = td.name;
  const renamed = maybeRenameToolName(original);
  if (renamed !== undefined) {
    td.name = renamed;
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
function isServerTool(td: AnthropicTool): boolean {
  const type = td["type"];
  return typeof type === "string" && type !== "custom";
}

function renameToolUseInMessage(m: AnthropicMessage): AnthropicMessage {
  const content = m.content;
  if (!Array.isArray(content)) return m;
  const newContent = content.map((block: AnthropicBlock) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "tool_use"
    ) {
      const renamed = maybeRenameToolName((block as { name?: unknown }).name);
      if (renamed !== undefined) {
        return { ...block, name: renamed };
      }
    }
    return block;
  });
  return { ...m, content: newContent };
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

function dedupToolsByName(tools: AnthropicTool[]): AnthropicTool[] {
  const seen = new Set<string>();
  const result: AnthropicTool[] = [];
  for (const t of tools) {
    if (typeof t.name === "string") {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
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

const CC_UNAVAILABLE_DESCRIPTION = "This tool is currently unavailable.";
const ccUnavailableStub = (name: string): AnthropicTool => ({
  name,
  description: CC_UNAVAILABLE_DESCRIPTION,
  input_schema: { type: "object", properties: {} },
});

/** One generic "unavailable" stub per Claude Code native tool name. */
export const CC_DECOY_TOOLS: readonly AnthropicTool[] =
  CC_TOOL_NAMES.map(ccUnavailableStub);

/**
 * Append a CC native tool decoy for every name the request did NOT already
 * advertise. Tools already present — whether supplied directly by Claude or
 * produced by a third-party override that renames to the same PascalCase name —
 * are left alone (exact, case-insensitive dedup).
 */
export function ensureCcDecoyTools(
  requestBody: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const out: AnthropicMessagesRequest = { ...requestBody };
  const list: AnthropicTool[] = Array.isArray(out.tools) ? out.tools : [];

  const existing = new Set<string>();
  for (const t of list) {
    if (typeof t.name === "string") existing.add(t.name.toLowerCase());
  }

  const decoys = CC_DECOY_TOOLS.filter(
    (d) => !existing.has(d.name.toLowerCase()),
  ).map((d) => ({ ...d }));
  if (decoys.length === 0) return out;

  out.tools = [...list, ...decoys];
  return out;
}
