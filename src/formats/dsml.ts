import { randomBytes } from "crypto";
import { Transform, type TransformCallback } from "stream";
import { SseFrameReader, parseSseData } from "./sse/frame";
import type { ChatCompletionChunk } from "./wire/openai-chat";

export interface DsmlToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type DsmlEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: DsmlToolCall };

type Prefix = "<｜DSML｜" | "<|DSML|";
type ParseResult =
  | { status: "complete"; end: number; call: DsmlToolCall }
  | { status: "incomplete" }
  | { status: "invalid" };

const PREFIXES: Prefix[] = ["<｜DSML｜", "<|DSML|"];
const WRAPPER_NAMES = ["tool_calls", "toolcalls"] as const;
const MAX_HELD = 64 * 1024;

function createCallId(): string {
  return `call_${randomBytes(12).toString("hex")}`;
}

function prefixAt(text: string, offset: number): Prefix | null {
  for (const prefix of PREFIXES) {
    if (text.startsWith(prefix, offset)) return prefix;
  }
  return null;
}

function markerAt(text: string, offset: number): number {
  let result = -1;
  for (const prefix of PREFIXES) {
    const candidate = text.indexOf(prefix, offset);
    if (candidate >= 0 && (result < 0 || candidate < result)) result = candidate;
  }
  return result;
}

function partialPrefixLength(text: string): number {
  let longest = 0;
  for (const prefix of PREFIXES) {
    const max = Math.min(prefix.length - 1, text.length);
    for (let length = max; length > longest; length--) {
      if (text.endsWith(prefix.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function skipWhitespace(text: string, offset: number): number {
  let cursor = offset;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  return cursor;
}

function closeTags(prefix: Prefix, kind: string): string[] {
  return [`${prefix}/${kind}>`, `</${prefix.slice(1)}${kind}>`];
}

function closeAt(text: string, offset: number, prefix: Prefix, kind: string): string | null {
  for (const tag of closeTags(prefix, kind)) {
    if (text.startsWith(tag, offset)) return tag;
  }
  return null;
}

function nextClose(text: string, offset: number, prefix: Prefix, kind: string): { index: number; tag: string } | null {
  let result: { index: number; tag: string } | null = null;
  for (const tag of closeTags(prefix, kind)) {
    const index = text.indexOf(tag, offset);
    if (index >= 0 && (!result || index < result.index)) result = { index, tag };
  }
  return result;
}

function parseOpening(
  text: string,
  offset: number,
  prefix: Prefix,
  kind: "invoke" | "parameter",
): { end: number; name: string; preserveString: boolean } | null | undefined {
  const end = text.indexOf(">", offset + prefix.length);
  if (end < 0) return null;
  const tag = text.slice(offset, end + 1);
  const match = tag.match(new RegExp(`^${prefix.replace(/[|\\]/g, "\\$&")}${kind}\\s+name="([^"]*)"`));
  if (!match || !/"\s*>$/.test(tag)) return undefined;
  const stringAttribute = tag.match(/\bstring="(true|false)"/);
  return {
    end: end + 1,
    name: match[1],
    preserveString: kind === "invoke" || stringAttribute?.[1] !== "false",
  };
}

function parseInvokeAt(text: string, offset: number): ParseResult {
  const prefix = prefixAt(text, offset);
  if (!prefix) return { status: "invalid" };
  const parsed = parseOpening(text, offset, prefix, "invoke");
  if (parsed === null) return { status: "incomplete" };
  if (!parsed || !parsed.name.trim()) return { status: "invalid" };

  const argumentsObject: Record<string, unknown> = {};
  let cursor = parsed.end;
  while (cursor <= text.length) {
    const structural = skipWhitespace(text, cursor);
    const invokeClose = closeAt(text, structural, prefix, "invoke");
    if (invokeClose) {
      return {
        status: "complete",
        end: structural + invokeClose.length,
        call: {
          id: createCallId(),
          name: parsed.name.trim(),
          arguments: JSON.stringify(argumentsObject),
        },
      };
    }
    if (structural >= text.length) return { status: "incomplete" };
    if (!text.startsWith(prefix, structural)) {
      return partialPrefixLength(text.slice(structural)) > 0
        ? { status: "incomplete" }
        : { status: "invalid" };
    }
    const parameter = parseOpening(text, structural, prefix, "parameter");
    if (parameter === null) return { status: "incomplete" };
    if (!parameter) return { status: "invalid" };
    const valueClose = nextClose(text, parameter.end, prefix, "parameter");
    if (!valueClose) return { status: "incomplete" };
    const raw = text.slice(parameter.end, valueClose.index);
    let value: unknown = raw;
    if (!parameter.preserveString) {
      try {
        value = JSON.parse(raw.trim());
      } catch {
        value = raw;
      }
    }
    argumentsObject[parameter.name] = value;
    cursor = valueClose.index + valueClose.tag.length;
  }
  return { status: "incomplete" };
}

function wrapperAt(text: string, offset: number): { prefix: Prefix; name: string; end: number } | null {
  const prefix = prefixAt(text, offset);
  if (!prefix) return null;
  for (const name of WRAPPER_NAMES) {
    const tag = `${prefix}${name}>`;
    if (text.startsWith(tag, offset)) return { prefix, name, end: offset + tag.length };
  }
  return null;
}

type Segment = DsmlEvent;

function appendText(segments: Segment[], text: string): void {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") previous.text += text;
  else segments.push({ type: "text", text });
}

function parseBody(body: string): { segments: Segment[]; valid: boolean } {
  const segments: Segment[] = [];
  let cursor = 0;
  let textStart = 0;
  let valid = false;
  while (cursor < body.length) {
    const marker = markerAt(body, cursor);
    if (marker < 0) break;
    const result = parseInvokeAt(body, marker);
    if (result.status !== "complete") {
      cursor = marker + 1;
      continue;
    }
    appendText(segments, body.slice(textStart, marker));
    segments.push({ type: "tool_call", call: result.call });
    valid = true;
    cursor = result.end;
    textStart = cursor;
  }
  appendText(segments, body.slice(textStart));
  return { segments, valid };
}

function scan(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let visibleStart = 0;
  while (cursor < text.length) {
    const marker = markerAt(text, cursor);
    if (marker < 0) break;
    const wrapper = wrapperAt(text, marker);
    if (wrapper) {
      const close = nextClose(text, wrapper.end, wrapper.prefix, wrapper.name);
      if (close) {
        const parsedBody = parseBody(text.slice(wrapper.end, close.index));
        if (parsedBody.valid) {
          appendText(segments, text.slice(visibleStart, marker));
          for (const segment of parsedBody.segments) {
            if (segment.type === "text") appendText(segments, segment.text);
            else segments.push(segment);
          }
          cursor = close.index + close.tag.length;
          visibleStart = cursor;
          continue;
        }
      }
    }
    const result = parseInvokeAt(text, marker);
    if (result.status === "complete") {
      appendText(segments, text.slice(visibleStart, marker));
      segments.push({ type: "tool_call", call: result.call });
      cursor = result.end;
      visibleStart = cursor;
      continue;
    }
    cursor = marker + 1;
  }
  appendText(segments, text.slice(visibleStart));
  return segments;
}

export function parseDsmlToolCalls(text: string): { text: string; calls: DsmlToolCall[] } {
  const segments = scan(text);
  return {
    text: segments.filter((segment): segment is { type: "text"; text: string } => segment.type === "text").map((segment) => segment.text).join(""),
    calls: segments.filter((segment): segment is { type: "tool_call"; call: DsmlToolCall } => segment.type === "tool_call").map((segment) => segment.call),
  };
}

export class DsmlToolCallHealer {
  private pending = "";
  private completed: DsmlToolCall[] = [];

  feedEvents(input: string): DsmlEvent[] {
    if (input) this.pending += input;
    if (this.pending.length > MAX_HELD) {
      this.pending = "";
      return [];
    }
    const events: DsmlEvent[] = [];
    while (this.pending) {
      const marker = markerAt(this.pending, 0);
      if (marker < 0) {
        const partial = partialPrefixLength(this.pending);
        if (partial) {
          if (this.pending.length > partial) appendText(events, this.pending.slice(0, -partial));
          this.pending = this.pending.slice(-partial);
          break;
        }
        appendText(events, this.pending);
        this.pending = "";
        break;
      }
      if (marker > 0) {
        const before = this.pending.slice(0, marker);
        const partial = partialPrefixLength(before);
        if (partial) {
          if (before.length > partial) appendText(events, before.slice(0, -partial));
          this.pending = this.pending.slice(marker - partial);
          break;
        }
        appendText(events, before);
        this.pending = this.pending.slice(marker);
      }
      const wrapper = wrapperAt(this.pending, 0);
      if (wrapper) {
        const close = nextClose(this.pending, wrapper.end, wrapper.prefix, wrapper.name);
        if (!close) break;
        const parsedBody = parseBody(this.pending.slice(wrapper.end, close.index));
        if (!parsedBody.valid) appendText(events, this.pending.slice(0, close.index + close.tag.length));
        else for (const segment of parsedBody.segments) {
          if (segment.type === "text") appendText(events, segment.text);
          else events.push(segment);
        }
        this.pending = this.pending.slice(close.index + close.tag.length);
        continue;
      }
      const result = parseInvokeAt(this.pending, 0);
      if (result.status === "complete") {
        events.push({ type: "tool_call", call: result.call });
        this.pending = this.pending.slice(result.end);
        continue;
      }
      if (result.status === "incomplete") break;
      appendText(events, this.pending.slice(0, 1));
      this.pending = this.pending.slice(1);
    }
    for (const event of events) if (event.type === "tool_call") this.completed.push(event.call);
    return events;
  }

  feed(input: string): string {
    return this.feedEvents(input).filter((event): event is { type: "text"; text: string } => event.type === "text").map((event) => event.text).join("");
  }

  drainCompleted(): DsmlToolCall[] {
    const completed = this.completed;
    this.completed = [];
    return completed;
  }

  flushPending(): string {
    const pending = this.pending;
    this.pending = "";
    const marker = markerAt(pending, 0);
    return marker < 0 ? pending : pending.slice(0, marker);
  }
}

export const DSML_COMPAT_META = {
  label: "Temporary Cline DSML compatibility workaround",
  blurb: "Heals Cline's leaked DeepSeek DSML markup; remove this stage after Cline returns standard OpenAI tool calls.",
};

function serializeChunk(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export class DsmlChatStreamTransform extends Transform {
  private readonly reader = new SseFrameReader();
  private readonly healer = new DsmlToolCallHealer();
  private nativeSeen = false;
  private recovered = 0;
  private nextIndex = 0;

  constructor() {
    super({ highWaterMark: 0 });
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    for (const frame of this.reader.feed(chunk)) {
      for (const output of this.processFrame(frame)) this.push(output);
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    const frame = this.reader.flush();
    if (frame !== null) for (const output of this.processFrame(frame)) this.push(output);
    const tail = this.healer.flushPending();
    if (tail) this.push(serializeChunk({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] }));
    callback();
  }

  private processFrame(frame: string): string[] {
    const parsed = parseSseData(frame);
    if (parsed.data === null || parsed.data === "[DONE]") return [frame + "\n\n"];
    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(parsed.data) as ChatCompletionChunk;
    } catch {
      return [frame + "\n\n"];
    }
    if (!Array.isArray(chunk.choices)) return [frame + "\n\n"];
    this.nativeSeen ||= chunk.choices.some((choice) => Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0);
    const output: string[] = [];
    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (!delta || typeof delta.content !== "string") {
        const finish = choice.finish_reason === "stop" && this.recovered > 0 && !this.nativeSeen ? "tool_calls" : choice.finish_reason;
        output.push(serializeChunk({ ...chunk, choices: [{ ...choice, finish_reason: finish }] }));
        continue;
      }
      const events = this.healer.feedEvents(delta.content);
      const baseDelta = { ...delta };
      delete baseDelta.content;
      for (const event of events) {
        if (event.type === "text") {
          if (event.text) output.push(serializeChunk({ ...chunk, choices: [{ ...choice, delta: { ...baseDelta, content: event.text } }] }));
        } else if (!this.nativeSeen) {
          this.recovered++;
          output.push(serializeChunk({
            ...chunk,
            choices: [{
              ...choice,
              finish_reason: null,
              delta: {
                ...baseDelta,
                tool_calls: [{ index: this.nextIndex++, id: event.call.id, type: "function", function: { name: event.call.name, arguments: event.call.arguments } }],
              },
            }],
          }));
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        const finish = choice.finish_reason === "stop" && this.recovered > 0 && !this.nativeSeen ? "tool_calls" : choice.finish_reason;
        output.push(serializeChunk({ ...chunk, choices: [{ ...choice, delta: baseDelta, finish_reason: finish }] }));
      }
    }
    return output;
  }
}
