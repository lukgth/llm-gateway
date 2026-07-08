// Web-tool agent loop.
//
// When a Messages request asks for the hosted web_search / web_fetch tools and
// the gateway is configured to back them with Firecrawl, this loop takes over:
//
//   1. Rewrite the hosted tool defs into ordinary function tools.
//   2. Run a non-streaming upstream turn (engine.runMessagesTurn).
//   3. If the model emitted web tool_use blocks, execute them via Firecrawl,
//      append an assistant turn + a user turn of tool_result, and loop.
//   4. When the model stops calling web tools (or we hit the round cap), emit
//      the final assistant message to the client — as SSE if the client asked
//      to stream, otherwise as a single JSON body — in the CLIENT's wire
//      format (Messages or, if the client used /chat or /responses, bridged).
//
// The loop itself never streams from the upstream (each turn is buffered so we
// can inspect tool_use). Streaming to the CLIENT is synthesised at the end from
// the final message, so the client still gets an SSE response when it asked for
// one — the gateway just can't stream tokens *while a tool call is pending*.

import type { Request, Response } from "express";
import type { Logger } from "../logger";
import type { ForwardingEngine, ForwardContext } from "./engine";
import type { FirecrawlConfig } from "./firecrawl";
import {
  detectWebTools,
  rewriteRequest,
  executeWebTool,
  isWebToolName,
  type WebToolsPresent,
} from "./web-tools";
import { messagesResponseToChat } from "../anthropic-openai-bridge";
import { emitMessagesSse, emitChatSse } from "./web-tool-sse";

const MAX_ROUNDS = 8; // hard cap on tool round-trips per request

export interface LoopDeps {
  engine: ForwardingEngine;
  logger: Logger;
  firecrawl: FirecrawlConfig;
}

// Client wire format, derived from the request path.
type ClientFmt = "messages" | "chat" | "responses";

function clientFmt(path: string): ClientFmt {
  const p = path.split("?")[0];
  if (p.endsWith("/chat/completions")) return "chat";
  if (p.endsWith("/responses")) return "responses";
  return "messages";
}

interface Usage {
  input?: number;
  output?: number;
  cached?: number;
}

// Run the loop. Returns settlement info so the caller (engine hook) can update
// usage + write the request log exactly once, consistent with normal requests.
export async function runWebToolLoop(
  req: Request,
  res: Response,
  ctx: ForwardContext,
  present: WebToolsPresent,
  deps: LoopDeps,
): Promise<{ status: number; usage: Usage; error: string | null }> {
  const { engine, logger, firecrawl } = deps;
  const fmt = clientFmt(ctx.clientPath);
  const wantStream = ctx.isStream;

  // Working conversation in Messages shape. If the client spoke chat/responses,
  // ctx.requestBody has already been handed to us in Messages shape by the hook
  // (it converts before calling us), so we can treat it uniformly.
  const base = rewriteRequest(ctx.requestBody, present);
  const messages: unknown[] = Array.isArray(base.messages)
    ? [...(base.messages as unknown[])]
    : [];

  const total: Usage = {};
  const addUsage = (u: Usage) => {
    if (u.input) total.input = (total.input ?? 0) + u.input;
    if (u.output) total.output = (total.output ?? 0) + u.output;
    if (u.cached) total.cached = (total.cached ?? 0) + u.cached;
  };

  let finalMessage: Record<string, unknown> | null = null;
  let lastStatus = 200;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const turnBody = { ...base, messages };
    const turn = await engine.runMessagesTurn(req, ctx, turnBody);
    if (!turn.ok) {
      return {
        status: turn.status,
        usage: total,
        error: `web-tool loop upstream failure: ${turn.reason}`,
      };
    }
    addUsage(turn.usage);
    const msg = turn.body;
    lastStatus = 200;

    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content.filter(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>).type === "tool_use" &&
        isWebToolName((b as Record<string, unknown>).name),
    ) as Array<Record<string, unknown>>;

    // No web tool calls -> this is the final answer.
    if (toolUses.length === 0) {
      finalMessage = msg;
      break;
    }

    logger.info("web_tool_round", {
      round: round + 1,
      calls: toolUses.map((t) => t.name).join(","),
    });

    // Append the assistant turn (with its tool_use blocks) verbatim.
    messages.push({ role: "assistant", content: msg.content });

    // Execute each web tool call and build a single user turn of tool_results.
    const results: unknown[] = [];
    for (const tu of toolUses) {
      const out = await executeWebTool(
        firecrawl,
        String(tu.name),
        (tu.input as Record<string, unknown>) ?? {},
      );
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [{ type: "text", text: out }],
      });
    }
    // Any NON-web tool_use in the same turn can't be satisfied by us — if the
    // model mixed a client tool in, stop and hand back what we have so the
    // client can take over.
    const hasForeignTool = content.some(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>).type === "tool_use" &&
        !isWebToolName((b as Record<string, unknown>).name),
    );
    if (hasForeignTool) {
      finalMessage = msg;
      break;
    }
    messages.push({ role: "user", content: results });
  }

  if (!finalMessage) {
    // Hit the round cap without a clean finish — return the last message if any,
    // else an error.
    return {
      status: 200,
      usage: total,
      error: `web-tool loop exceeded ${MAX_ROUNDS} rounds`,
    };
  }

  // Emit the final message to the client in its format.
  try {
    if (fmt === "chat") {
      const chat = messagesResponseToChat(finalMessage);
      if (wantStream) emitChatSse(res, chat);
      else sendJson(res, lastStatus, chat);
    } else {
      // messages (and responses clients tolerate Messages here in practice for
      // the web-tool use case; responses bridging for tool loops is out of
      // scope — treated as messages).
      if (wantStream) emitMessagesSse(res, finalMessage);
      else sendJson(res, lastStatus, finalMessage);
    }
  } catch (err) {
    return {
      status: 500,
      usage: total,
      error: `web-tool loop emit failed: ${(err as Error).message}`,
    };
  }

  return { status: lastStatus, usage: total, error: null };
}

// Re-export the detector so the hook can gate cheaply before constructing deps.
export { detectWebTools };

function sendJson(res: Response, status: number, body: unknown): void {
  if (res.headersSent) return;
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(buf.length),
  });
  res.end(buf);
}
