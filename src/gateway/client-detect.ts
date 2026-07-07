// Best-effort detection of the client application behind a gateway request.
//
// Coding agents and SDKs identify themselves through User-Agent (and a few
// side-channel headers like x-app). We match against an ordered rule list —
// most specific first — and fall back to the raw product token so unknown
// clients still show up as *something* useful in the logs.

import type { Request } from "express";

interface ClientRule {
  pattern: RegExp;
  name: string;
}

// Ordered: first match wins. Patterns are matched against the lowercased
// User-Agent string.
const RULES: ClientRule[] = [
  // --- coding agents / CLIs ---
  { pattern: /claude-cli|claude-code/, name: "claude code" },
  { pattern: /codex_cli|codex-cli|\bcodex\b/, name: "codex" },
  { pattern: /opencode/, name: "opencode" },
  { pattern: /\bdroid\b|factory-cli|factory_cli/, name: "droid" },
  { pattern: /\bpi\b|pi-cli|inflection/, name: "pi" },
  { pattern: /hermes/, name: "hermes" },
  { pattern: /\baider\b/, name: "aider" },
  { pattern: /\bcline\b/, name: "cline" },
  { pattern: /roo-?code|roo-?cline/, name: "roo code" },
  { pattern: /kilo-?code/, name: "kilo code" },
  { pattern: /geminicli|gemini-cli/, name: "gemini cli" },
  { pattern: /qwen-?code/, name: "qwen code" },
  { pattern: /goose/, name: "goose" },
  { pattern: /\bcrush\b/, name: "crush" },
  { pattern: /\bamp\b|ampcode/, name: "amp" },
  { pattern: /copilot/, name: "copilot" },
  { pattern: /cursor/, name: "cursor" },
  { pattern: /windsurf/, name: "windsurf" },
  { pattern: /\bzed\b/, name: "zed" },
  { pattern: /continue/, name: "continue" },
  // --- chat / desktop apps ---
  { pattern: /librechat/, name: "librechat" },
  { pattern: /openwebui|open-webui/, name: "open webui" },
  { pattern: /lobechat|lobe-chat/, name: "lobechat" },
  { pattern: /chatbox/, name: "chatbox" },
  { pattern: /cherry ?studio/, name: "cherry studio" },
  { pattern: /jan\b/, name: "jan" },
  // --- proxies / frameworks ---
  { pattern: /litellm/, name: "litellm" },
  { pattern: /langchain/, name: "langchain" },
  { pattern: /llamaindex|llama-index/, name: "llamaindex" },
  // --- raw SDKs (least specific — agents above embed these too) ---
  { pattern: /anthropic-sdk|@anthropic-ai/, name: "anthropic sdk" },
  { pattern: /openai-python|openai-node|openai\//, name: "openai sdk" },
  { pattern: /\bcurl\b/, name: "curl" },
  { pattern: /python-requests|python-httpx|\bhttpx\b|aiohttp/, name: "python" },
  { pattern: /node-fetch|undici|axios/, name: "node" },
  { pattern: /postman/, name: "postman" },
  { pattern: /insomnia/, name: "insomnia" },
];

// Headers that carry app identity beyond User-Agent, in priority order.
// x-app: Claude Code sends "cli"; x-stainless-* come from Stainless-generated
// SDKs and identify the runtime rather than the app, so UA wins over them.
function haystack(req: Request): string {
  const parts = [
    req.header("user-agent") ?? "",
    req.header("x-app") ?? "",
    req.header("http-referer") ?? "",
    req.header("x-title") ?? "",
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

// Returns a short lowercase client label ("claude code", "codex", …) or null
// when nothing identifiable was sent.
export function detectClient(req: Request): string | null {
  const hay = haystack(req);
  if (!hay) return null;

  // "x-app: cli" together with an anthropic SDK UA is Claude Code's signature.
  if (req.header("x-app") === "cli" && /anthropic/.test(hay)) {
    return "claude code";
  }

  for (const rule of RULES) {
    if (rule.pattern.test(hay)) return rule.name;
  }

  // Fall back to the first product token of the UA ("MyTool/1.2" -> "mytool")
  // so unknown-but-labelled clients are still distinguishable.
  const ua = (req.header("user-agent") ?? "").trim();
  const token = ua.split(/[\s/]+/)[0]?.toLowerCase();
  return token ? token.slice(0, 32) : null;
}
