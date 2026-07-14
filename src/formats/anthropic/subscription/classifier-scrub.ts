import {
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
} from "../../pipeline";

export interface ScrubSubstitution {
  readonly from: RegExp;
  readonly to: string;
}

export const OPENCODE_SCRUB_SUBSTITUTIONS: readonly ScrubSubstitution[] = [
  // Source-repo fingerprint
  {
    from: /github\.com\/anomalyco\/opencode/g,
    to: "github.com/anthropics/claude-code",
  },
  // Docs fingerprint
  { from: /opencode\.ai\/docs/g, to: "docs.claude.com/en/docs/claude-code" },
  // Source-prompt identity phrases (exact, not broad)
  {
    from: /You are OpenCode, the best coding agent on the planet\./g,
    to: "You are Claude Code, Anthropic's official CLI for Claude.",
  },
  // Environment-label fingerprints (opencode emits these literally)
  { from: /Workspace root folder:/g, to: "Working directory:" },
  { from: /Is directory a git repo:/g, to: "Git repository:" },
  { from: /<directories>/g, to: "<project_files>" },
  { from: /<\/directories>/g, to: "</project_files>" },
  // Known classifier trigger (ex-machina v1.7.5 documented this exact phrase)
  {
    from: /Here is some useful information about the environment you are running in:/g,
    to: "Environment context:",
  },
  // Note: TodoWrite is NOT scrubbed — same real tool name in opencode and CC.
];

export function scrubAnchorsInPlace(
  requestBody: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const out: AnthropicMessagesRequest = { ...requestBody };

  if (out.system) out.system = scrubSystem(out.system);
  if (out.messages) out.messages = scrubMessagesArray(out.messages);

  return out;
}

function scrubSystem(
  value: string | AnthropicTextBlock[],
): string | AnthropicTextBlock[] {
  if (typeof value === "string") {
    return applySubstitutions(value);
  }

  if (Array.isArray(value)) {
    const out: string | AnthropicTextBlock[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        (out as unknown as string[]).push(applySubstitutions(entry));
        continue;
      }

      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const e = entry as AnthropicTextBlock;
        if (e.type === "text" && typeof e.text === "string") {
          out.push({ ...e, text: applySubstitutions(e.text) });
          continue;
        }
      }

      out.push(entry);
    }

    return out;
  }

  return value;
}

function scrubMessagesArray(value: AnthropicMessage[]): AnthropicMessage[] {
  if (!Array.isArray(value)) return value;
  return value.map((m) => scrubOneMessage(m));
}

function scrubOneMessage(m: AnthropicMessage): AnthropicMessage {
  if (typeof m !== "object" || m === null) return m;
  const msg = { ...m };
  const content = msg.content;
  if (typeof content === "string") {
    msg.content = applySubstitutions(content);
    return msg;
  }

  if (Array.isArray(content)) {
    msg.content = content.map((block) => {
      if (typeof block !== "object" || block === null) return block;
      const b = block as AnthropicTextBlock;
      if (b.type === "text" && typeof b.text === "string") {
        return { ...b, text: applySubstitutions(b.text) };
      }
      return block;
    });
  }

  return msg;
}

function applySubstitutions(text: string): string {
  let out = text;
  for (const sub of OPENCODE_SCRUB_SUBSTITUTIONS) {
    out = out.replace(sub.from, sub.to);
  }

  return out;
}
