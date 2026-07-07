// Bidirectional bridge between the Anthropic Messages API (/v1/messages) and
// the OpenAI Chat Completions API (/v1/chat/completions).
//
// Used by the gateway when a model's chosen provider endpoint speaks a
// different wire format than the client. The request side converts the body
// the client sent into the provider's shape; the response side converts the
// provider's reply back into the client's shape. Streaming responses are
// converted chunk-by-chunk via the two transform streams below.
//
// Coverage:
//   - text content (string and part arrays)
//   - system prompt (system message <-> `system` field)
//   - images (anthropic image source <-> openai image_url)
//   - tools (input_schema <-> parameters) and tool_choice shapes
//   - tool_use <-> assistant tool_calls; tool_result <-> role:'tool'
//   - stop_reason / finish_reason mapping
//   - usage token-field renaming
//   - reasoning_effort passthrough
//
// We only model the fields we touch; everything else is passed through
// opaquely via index signatures.

import crypto from "crypto";
import { Transform, type TransformCallback } from "stream";
import { stripInvisible } from "./utils";

// --- shared helpers --------------------------------------------------------

function genId(prefix: string): string {
  return prefix + crypto.randomBytes(12).toString("hex");
}

// Map OpenAI finish_reason -> Anthropic stop_reason.
const FINISH_TO_STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};
const STOP_TO_FINISH: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
};

// --- content translation ---------------------------------------------------

type AnthropicBlock = Record<string, unknown>;
type ChatContentPart = Record<string, unknown>;

// Anthropic content (string | block[]) -> OpenAI content (string | part[]).
function anthropicContentToChat(content: unknown): unknown {
  if (content == null) return content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const parts: ChatContentPart[] = [];
  for (const bRaw of content) {
    if (!bRaw || typeof bRaw !== "object") continue;
    const b = bRaw as AnthropicBlock;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" || b.type === "input_image") {
      const src = b.source as
        { type?: string; data?: string; media_type?: string } | undefined;
      const url =
        src && src.type === "base64" && src.data
          ? `data:${src.media_type || "image/png"};base64,${src.data}`
          : (b.url as string | undefined);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts.length ? parts : "";
}

// OpenAI content (string | part[]) -> Anthropic content (block[]).
function chatContentToAnthropic(content: unknown): AnthropicBlock[] {
  const out: AnthropicBlock[] = [];
  if (typeof content === "string") {
    if (content) out.push({ type: "text", text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const pRaw of content) {
    if (!pRaw || typeof pRaw !== "object") continue;
    const p = pRaw as ChatContentPart;
    if (
      (p.type === "text" ||
        p.type === "input_text" ||
        p.type === "output_text") &&
      typeof p.text === "string"
    ) {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "image_url") {
      const url = (p.image_url as { url?: string } | undefined)?.url;
      if (typeof url === "string") {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (m) {
          out.push({
            type: "image",
            source: { type: "base64", media_type: m[1], data: m[2] },
          });
        } else {
          out.push({ type: "image", source: { type: "url", url } });
        }
      }
    }
  }
  return out;
}

// --- tools translation -----------------------------------------------------

function anthropicToolsToChat(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const t = tRaw as Record<string, unknown>;
    if (t.type === "computer_20241022" || t.type === "web_search") continue; // hosted, not portable
    out.push({
      type: "function",
      function: {
        name: t.name,
        ...(t.description != null ? { description: t.description } : {}),
        ...(t.input_schema != null ? { parameters: t.input_schema } : {}),
      },
    });
  }
  return out.length ? out : undefined;
}

function chatToolsToAnthropic(
  tools: unknown,
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const tRaw of tools) {
    if (!tRaw || typeof tRaw !== "object") continue;
    const t = tRaw as Record<string, unknown>;
    const fn = (t.function as Record<string, unknown> | undefined) ?? t;
    if (typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      ...(fn.description != null ? { description: fn.description } : {}),
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return out.length ? out : undefined;
}

function anthropicToolChoiceToChat(tc: unknown): unknown {
  if (tc == null || typeof tc !== "object") return tc;
  const o = tc as Record<string, unknown>;
  if (o.type === "any") return "required";
  if (o.type === "auto") return "auto";
  if (o.type === "none") return "none";
  if (o.type === "tool" && typeof o.name === "string")
    return { type: "function", function: { name: o.name } };
  return tc;
}

function chatToolChoiceToAnthropic(tc: unknown): unknown {
  if (typeof tc === "string") {
    if (tc === "required") return { type: "any" };
    if (tc === "auto" || tc === "none") return { type: tc };
    return { type: "auto" };
  }
  if (tc && typeof tc === "object") {
    const o = tc as Record<string, unknown>;
    const fn = o.function as { name?: string } | undefined;
    if (fn && typeof fn.name === "string")
      return { type: "tool", name: fn.name };
  }
  return { type: "auto" };
}

// --- request: Anthropic Messages -> OpenAI Chat ----------------------------

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export function messagesRequestToChat(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const messages: ChatMessage[] = [];

  // system -> leading system message (string or text blocks).
  if (body.system != null) {
    const sys = Array.isArray(body.system)
      ? (body.system as Array<Record<string, unknown>>)
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .join("\n")
      : typeof body.system === "string"
        ? body.system
        : "";
    if (sys) messages.push({ role: "system", content: sys });
  }

  const inMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const mRaw of inMessages) {
    if (!mRaw || typeof mRaw !== "object") continue;
    const m = mRaw as { role?: string; content?: unknown };
    const role = m.role === "assistant" ? "assistant" : "user";

    // Split out tool_result blocks — these become their own role:'tool' msgs.
    if (Array.isArray(m.content)) {
      const blocks = m.content as AnthropicBlock[];
      const results = blocks.filter((b) => b.type === "tool_result");
      const rest = blocks.filter((b) => b.type !== "tool_result");
      for (const r of results) {
        const rc = r.content;
        const text =
          typeof rc === "string"
            ? rc
            : Array.isArray(rc)
              ? (rc as Array<Record<string, unknown>>)
                  .map((b) => (typeof b.text === "string" ? b.text : ""))
                  .join("")
              : "";
        messages.push({
          role: "tool",
          tool_call_id: typeof r.tool_use_id === "string" ? r.tool_use_id : "",
          content: text,
        });
      }
      if (rest.length) {
        const msg = assembleChatMessage(role, rest);
        if (msg) messages.push(msg);
      }
    } else {
      const msg = assembleChatMessage(role, m.content);
      if (msg) messages.push(msg);
    }
  }

  out.messages = messages;
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (body.stream != null) out.stream = body.stream;
  if (typeof body.user === "string") out.user = body.user;

  const tools = anthropicToolsToChat(body.tools);
  if (tools) out.tools = tools;
  const tc = anthropicToolChoiceToChat(body.tool_choice);
  if (tc != null) out.tool_choice = tc;

  return out;
}

// Build one Chat message from a role + anthropic content (string or non-result
// block array). Returns null when there's nothing (e.g. only tool_results).
function assembleChatMessage(
  role: string,
  content: unknown,
): ChatMessage | null {
  if (role === "assistant") {
    // Pull tool_use blocks into tool_calls.
    const blocks = Array.isArray(content)
      ? (content as AnthropicBlock[])
      : typeof content === "string"
        ? [{ type: "text", text: content }]
        : [];
    const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
    const parts: ChatContentPart[] = [];
    for (const b of blocks) {
      if (b.type === "tool_use") {
        toolCalls.push({
          id: typeof b.id === "string" ? b.id : genId("call_"),
          type: "function",
          function: {
            name: String(b.name ?? ""),
            arguments:
              typeof b.input === "string"
                ? b.input
                : JSON.stringify(b.input ?? {}),
          },
        });
      } else if (b.type === "text" && typeof b.text === "string") {
        parts.push({ type: "text", text: b.text });
      }
    }
    const msg: ChatMessage = { role };
    if (parts.length === 1) msg.content = parts[0].text;
    else if (parts.length > 1) msg.content = parts;
    else msg.content = null;
    if (toolCalls.length) msg.tool_calls = toolCalls;
    // Only push if there's something to say.
    if (msg.content == null && !toolCalls.length) return null;
    return msg;
  }
  // user
  if (typeof content === "string") {
    return content ? { role, content } : null;
  }
  const converted = anthropicContentToChat(content);
  if (Array.isArray(converted) && converted.length === 0) return null;
  if (typeof converted === "string" && !converted) return null;
  return { role, content: converted };
}

// --- request: OpenAI Chat -> Anthropic Messages ----------------------------

export function chatRequestToMessages(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const messages: Array<{ role: string; content: unknown }> = [];
  let systemText = "";

  const inMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const mRaw of inMessages) {
    if (!mRaw || typeof mRaw !== "object") continue;
    const m = mRaw as ChatMessage;
    if (m.role === "system") {
      const t = typeof m.content === "string" ? m.content : "";
      if (t) systemText = systemText ? `${systemText}\n${t}` : t;
      continue;
    }
    if (m.role === "tool") {
      // -> a user message with a single tool_result block.
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content:
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content ?? ""),
          },
        ],
      });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = [];
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      // text first (if any), then tool_use blocks
      if (typeof m.content === "string" && m.content)
        blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id || genId("toolu_"),
          name: tc.function.name,
          input: safeParse(tc.function.arguments),
        });
      }
    } else {
      blocks.push(...chatContentToAnthropic(m.content));
    }
    if (blocks.length) messages.push({ role, content: blocks });
  }

  if (systemText) out.system = systemText;
  out.messages = messages;
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === "number")
    out.max_tokens = body.max_completion_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stream != null) out.stream = body.stream;
  // Anthropic requires max_tokens; default generously if absent.
  if (typeof out.max_tokens !== "number") out.max_tokens = 4096;

  const tools = chatToolsToAnthropic(body.tools);
  if (tools) out.tools = tools;
  const tc = chatToolChoiceToAnthropic(body.tool_choice);
  if (tc != null) out.tool_choice = tc;

  return out;
}

function safeParse(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// --- response: OpenAI Chat -> Anthropic Messages (non-streaming) -----------

export function chatResponseToMessages(
  chat: Record<string, unknown>,
): Record<string, unknown> {
  const choices =
    (chat.choices as Array<Record<string, unknown>> | undefined) ?? [];
  const choice = choices[0] ?? {};
  const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
  const content: AnthropicBlock[] = [];

  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content as AnthropicBlock[]) {
      if (typeof p.text === "string")
        content.push({ type: "text", text: p.text });
    }
  }
  const stopReason =
    FINISH_TO_STOP[choice.finish_reason as string] ?? "end_turn";

  const toolCalls = msg.tool_calls as
    | Array<{ id: string; function: { name: string; arguments?: string } }>
    | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id || genId("toolu_"),
        name: tc.function.name,
        input: safeParse(tc.function.arguments),
      });
    }
  }

  const usage = chat.usage as
    { prompt_tokens?: number; completion_tokens?: number } | undefined;

  return {
    id: (chat.id as string) || genId("msg_"),
    type: "message",
    role: "assistant",
    model: chat.model ?? "",
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

// --- response: Anthropic Messages -> OpenAI Chat (non-streaming) -----------

export function messagesResponseToChat(
  msgBody: Record<string, unknown>,
): Record<string, unknown> {
  const blocks = (msgBody.content as AnthropicBlock[] | undefined) ?? [];
  let textContent: string | null = null;
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      textContent = textContent == null ? b.text : textContent + b.text;
    } else if (b.type === "tool_use") {
      toolCalls.push({
        id: (b.id as string) || genId("call_"),
        type: "function",
        function: {
          name: String(b.name ?? ""),
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant" };
  if (textContent != null) message.content = textContent;
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (textContent == null && !toolCalls.length) message.content = null;

  const finish = STOP_TO_FINISH[msgBody.stop_reason as string] ?? "stop";
  const usage = msgBody.usage as
    { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    id: (msgBody.id as string) || genId("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msgBody.model ?? "",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
    },
  };
}

// ===========================================================================
// Streaming transforms
// ===========================================================================

// Chat SSE -> Anthropic Messages SSE.
//
// Chat chunks carry delta.content / delta.tool_calls / finish_reason + usage.
// We emit the Anthropic event sequence:
//   message_start -> content_block_start/delta/stop -> message_delta -> message_stop
export class ChatToMessagesSseTransform extends Transform {
  private buf = Buffer.alloc(0);
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private textBlockOpen = false;
  private toolBlocks = new Map<number, number>(); // chat tool index -> anthropic block index
  private readonly model: string | null;

  constructor(model?: string | null) {
    super();
    this.model = model ?? null;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.buf = Buffer.concat([
      this.buf,
      Buffer.from(stripInvisible(chunk.toString("utf8")), "utf8"),
    ]);
    while (true) {
      const idx = this.buf.indexOf("\n\n");
      if (idx === -1) break;
      const evt = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handleEvent(evt.toString("utf8"));
    }
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (this.buf.length && !this.finished)
      this.handleEvent(this.buf.toString("utf8"));
    this.buf = Buffer.alloc(0);
    cb();
  }

  private send(obj: { type: string } & Record<string, unknown>): void {
    // Anthropic SSE uses an `event: <type>` line plus a `data:` line. Both are
    // required — clients (e.g. Claude Code) key off the event line.
    this.push(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  private startMessage(): void {
    this.started = true;
    this.send({
      type: "message_start",
      message: {
        id: genId("msg_"),
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private openTextBlock(): number {
    const i = this.nextIndex++;
    this.textBlockOpen = true;
    this.send({
      type: "content_block_start",
      index: i,
      content_block: { type: "text", text: "" },
    });
    return i;
  }

  private handleEvent(raw: string): void {
    const lines = raw.split("\n");
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const p = line.slice(5);
        dataStr += p.startsWith(" ") ? p.slice(1) : p;
      }
    }
    if (!dataStr) return;
    if (this.finished) return; // ignore trailing [DONE] / chunks after message_stop
    if (dataStr === "[DONE]") {
      if (!this.started) this.startMessage();
      if (this.textBlockOpen) {
        this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
        this.textBlockOpen = false;
      }
      for (const idx of this.toolBlocks.values())
        this.send({ type: "content_block_stop", index: idx });
      this.toolBlocks.clear();
      this.send({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      this.send({ type: "message_stop" });
      this.finished = true;
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (!this.started) this.startMessage();

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) {
        if (!this.textBlockOpen) this.openTextBlock();
        this.send({
          type: "content_block_delta",
          index: this.nextIndex - 1,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      const tcArr = delta.tool_calls as
        | Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined;
      if (Array.isArray(tcArr)) {
        // Close any open text block before emitting tool_use.
        if (this.textBlockOpen) {
          this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
          this.textBlockOpen = false;
        }
        for (const tc of tcArr) {
          const ci = tc.index ?? 0;
          let blockIndex = this.toolBlocks.get(ci);
          if (blockIndex === undefined) {
            blockIndex = this.nextIndex++;
            this.toolBlocks.set(ci, blockIndex);
            this.send({
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id || genId("toolu_"),
                name: tc.function?.name ?? "",
                input: {},
              },
            });
          } else if (tc.function?.name) {
            // name arriving late (rare) — ignore
          }
          if (tc.function?.arguments) {
            this.send({
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }
    }

    const finish = choice?.finish_reason as string | undefined;
    if (finish) {
      if (this.textBlockOpen) {
        this.send({ type: "content_block_stop", index: this.nextIndex - 1 });
        this.textBlockOpen = false;
      }
      for (const idx of this.toolBlocks.values())
        this.send({ type: "content_block_stop", index: idx });
      this.toolBlocks.clear();
      const usage = chunk.usage as
        { prompt_tokens?: number; completion_tokens?: number } | undefined;
      this.send({
        type: "message_delta",
        delta: {
          stop_reason: FINISH_TO_STOP[finish] ?? "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: usage?.completion_tokens ?? 0,
          input_tokens: usage?.prompt_tokens,
        },
      });
      this.send({ type: "message_stop" });
      this.finished = true;
    }
  }
}

// Anthropic Messages SSE -> Chat SSE chunks.
//
// Walks Anthropic content_block_start/delta/stop + message_delta/stop and
// emits chat.completion.chunk objects with delta.content / tool_calls /
// finish_reason + usage on the final chunk.
export class MessagesToChatSseTransform extends Transform {
  private buf = Buffer.alloc(0);
  private started = false;
  private readonly model: string | null;
  private textBlockOpen = false;
  // Map anthropic block index -> chat tool index + accumulating id/name.
  private toolBlocks = new Map<
    number,
    { chatIndex: number; id: string; name: string }
  >();
  private nextToolChatIndex = 0;
  private finishReason: string | null = null;
  private usage: { prompt_tokens?: number; completion_tokens?: number } = {};

  constructor(model?: string | null) {
    super();
    this.model = model ?? null;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.buf = Buffer.concat([
      this.buf,
      Buffer.from(stripInvisible(chunk.toString("utf8")), "utf8"),
    ]);
    while (true) {
      const idx = this.buf.indexOf("\n\n");
      if (idx === -1) break;
      const evt = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handleEvent(evt.toString("utf8"));
    }
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (this.buf.length) this.handleEvent(this.buf.toString("utf8"));
    this.buf = Buffer.alloc(0);
    if (this.started && this.finishReason == null) {
      this.emitChunk({ finish_reason: "stop" });
      this.emitDone();
    }
    cb();
  }

  private emitChunk(
    delta: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): void {
    const obj: Record<string, unknown> = {
      id: genId("chatcmpl-"),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model ?? "",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    if (extra) Object.assign(obj, extra);
    this.push(`data: ${JSON.stringify(obj)}\n\n`);
  }

  private emitDone(): void {
    this.push("data: [DONE]\n\n");
  }

  private start(): void {
    this.started = true;
    this.emitChunk({ role: "assistant", content: "" });
  }

  private handleEvent(raw: string): void {
    const lines = raw.split("\n");
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const p = line.slice(5);
        dataStr += p.startsWith(" ") ? p.slice(1) : p;
      }
    }
    if (!dataStr) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (!this.started) this.start();
    const type = data.type as string;

    if (type === "content_block_start") {
      const block = data.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        const idx = data.index as number;
        const chatIndex = this.nextToolChatIndex++;
        this.toolBlocks.set(idx, {
          chatIndex,
          id: (block.id as string) || genId("call_"),
          name: (block.name as string) ?? "",
        });
        this.emitChunk({
          tool_calls: [
            {
              index: chatIndex,
              id: block.id,
              type: "function",
              function: { name: block.name ?? "", arguments: "" },
            },
          ],
        });
      }
      return;
    }
    if (type === "content_block_delta") {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.emitChunk({ content: delta.text });
      } else if (
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        const idx = data.index as number;
        const tb = this.toolBlocks.get(idx);
        if (tb) {
          this.emitChunk({
            tool_calls: [
              {
                index: tb.chatIndex,
                function: { arguments: delta.partial_json },
              },
            ],
          });
        }
      }
      return;
    }
    if (type === "message_delta") {
      const d = data.delta as Record<string, unknown> | undefined;
      if (d && typeof d.stop_reason === "string") {
        this.finishReason = STOP_TO_FINISH[d.stop_reason] ?? "stop";
      }
      const u = data.usage as
        { output_tokens?: number; input_tokens?: number } | undefined;
      if (u) {
        if (typeof u.output_tokens === "number")
          this.usage.completion_tokens = u.output_tokens;
        if (typeof u.input_tokens === "number")
          this.usage.prompt_tokens = u.input_tokens;
      }
      return;
    }
    if (type === "message_stop") {
      this.emitChunk(
        { finish_reason: this.finishReason ?? "stop" },
        { usage: this.usage },
      );
      this.emitDone();
      this.finishReason = this.finishReason ?? "stop";
      return;
    }
  }
}
