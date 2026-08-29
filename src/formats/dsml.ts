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

type ParseStatus =
  | { status: "complete"; end: number; call: DsmlToolCall }
  | { status: "incomplete" }
  | { status: "invalid" };

type Prefix = "<｜DSML｜" | "<|DSML|";
type Segment = DsmlEvent;

const PREFIXES: Prefix[] = ["<｜DSML｜", "<|DSML|"];
const WRAPPER_NAMES = ["tool_calls", "toolcalls"] as const;
const MAX_HELD = 64 * 1024;

function callId(): string {
  return `call_${randomBytes(12).toString("hex")}`;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefixAt(text: string, offset: number): Prefix | null {
  for (const prefix of PREFIXES) {
    if (text.startsWith(prefix, offset)) return prefix;
  }
  return null;
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

function markerAt(text: string, offset: number): number {
  let found = -1;
  for (const prefix of PREFIXES) {
    const candidate = text.indexOf(prefix, offset);
    if (candidate >= 0 && (found < 0 || candidate < found)) found = candidate;
  }
  return found;
}

function closingTags(prefix: Prefix, name: string): string[] {
  return [`${prefix}/${name}>`, `</${prefix.slice(1)}${name}>`];
}

function closingAt(text: string, offset: number, prefix: Prefix, name: string): string | null {
  for (const tag of closingTags(prefix, name)) {
    if (text.startsWith(tag, offset)) return tag;
  }
  return null;
}

function nextClosing(text: string, offset: number, prefix: Prefix, name: string): { index: number; tag: string } | null {
  let result: { index: number; tag: string } | null = null;
  for (const tag of closingTags(prefix, name)) {
    const index = text.indexOf(tag, offset);
    if (index >= 0 && (!result || index < result.index)) result = { index, tag };
  }
  return result;
}

function opening(
  text: string,
  offset: number,
  prefix: Prefix,
  kind: "invoke" | "parameter",
): { end: number; name: string; stringValue: boolean } | null | undefined {
  const end = text.indexOf(">", offset + prefix.length);
  if (end < 0) return null;
  const tag = text.slice(offset, end + 1);
  const nameMatch = tag.match(
    new RegExp(`^${escaped(prefix)}${kind}\\s+name="([^"]*)"`),
  );
  if (!nameMatch || !/"\s*>$/.test(tag)) return undefined;
  if (kind === "invoke") {
    return { end: end + 1, name: nameMatch[1], stringValue: true };
  }
  const stringMatch = tag.match(/\bstring="(true|false)"/);
  return {
    end: end + 1,
    name: nameMatch[1],
    stringValue: stringMatch?.[1] !== "false",
  };
}

function invokeAt(text: string, offset: number): ParseStatus {
  const prefix = prefixAt(text, offset);
  if (!prefix) return { status: "invalid" };
  const parsed = opening(text, offset, prefix, "invoke");
  if (parsed === null) return { status: "incomplete" };
  if (!parsed) return { status: "invalid" };
  const name = parsed.name.trim();
  if (!name) return { status: "invalid" };

  const values: Record<string, unknown> = {};
  let cursor = parsed.end;
  while (cursor <= text.length) {
    const invokeClose = closingAt(text, cursor, prefix, "invoke");
    if (invokeClose) {
      return {
        status: "complete",
        end: cursor + invokeClose.length,
        call: { id: callId(), name, arguments: JSON.stringify(values) },
      };
    }
    if (cursor === text.length) return { status: "incomplete" };
    if (!text.startsWith(prefix, cursor)) {
      return partialPrefixLength(text.slice(cursor)) > 0
        ? { status: "incomplete" }
        : { status: "invalid" };
    }
    const parameter = opening(text, cursor, prefix, "parameter");
    if (parameter === null) return { status: "incomplete" };
    if (!parameter) return { status: "invalid" };
    const valueClose = nextClosing(text, parameter.end, prefix, "parameter");
    if (!valueClose) return { status: "incomplete" };
    const raw = text.slice(parameter.end, valueClose.index);
    let value: unknown = raw;
    if (!parameter.stringValue) {
      try {
        value = JSON.parse(raw.trim());
      } catch {
        value = raw;
      }
    }
    values[parameter.name] = value;
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

function bodySegments(body: string): { segments: Segment[]; valid: boolean } {
  const segments: Segment[] = [];
  let cursor = 0;
  let textStart = 0;
  let valid = false;
  while (cursor < body.length) {
    const marker = markerAt(body, cursor);
    if (marker < 0) break;
    const result = invokeAt(body, marker);
    if (result.status !== "complete") {
      cursor = marker + 1;
      continue;
    }
    if (marker > textStart) segments.push({ type: "text", text: body.slice(textStart, marker) });
    segments.push({ type: "tool_call", call: result.call });
    valid = true;
    cursor = result.end;
    textStart = cursor;
  }
  if (textStart < body.length) segments.push({ type: "text", text: body.slice(textStart) });
  return { segments, valid };
}

function appendText(segments: Segment[], text: string): void {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") previous.text += text;
  else segments.push({ type: "text", text });
}

function scanComplete(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let textStart = 0;
  while (cursor < text.length) {
    const marker = markerAt(text, cursor);
    if (marker < 0) break;
    const wrapper = wrapperAt(text, marker);
    if (wrapper) {
      const close = nextClosing(text, wrapper.end, wrapper.prefix, wrapper.name);
      if (close) {
        const body = text.slice(wrapper.end, close.index);
        const parsedBody = bodySegments(body);
        if (parsedBody.valid) {
          appendText(segments, text.slice(textStart, marker));
          for (const segment of parsedBody.segments) {
            if (segment.type === "text") appendText(segments, segment.text);
            else segments.push(segment);
          }
          cursor = close.index + close.tag.length;
          textStart = cursor;
          continue;
        }
      }
    }
    const result = invokeAt(text, marker);
    if (result.status === "complete") {
      appendText(segments, text.slice(textStart, marker));
      segments.push({ type: "tool_call", call: result.call });
      cursor = result.end;
      textStart = cursor;
      continue;
    }
    cursor = marker + 1;
  }
  appendText(segments, text.slice(textStart));
  return segments;
}

export function parseDsmlToolCalls(text: string): { text: string; calls: DsmlToolCall[] } {
  const segments = scanComplete(text);
  return {
    text: segments
      .filter((segment): segment is { type: "text"; text: string } => segment.type === "text")
      .map((segment) => segment.text)
      .join(""),
    calls: segments
      .filter((segment): segment is { type: "tool_call"; call: DsmlToolCall } => segment.type === "tool_call")
      .map((segment) => segment.call),
  };
}

export class DsmlToolCallHealer {
  private pending = "";
  private completed: DsmlToolCall[] = [];

  feedEvents(text: string): DsmlEvent[] {
    if (text) this.pending += text;
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
        const close = nextClosing(this.pending, wrapper.end, wrapper.prefix, wrapper.name);
        if (!close) break;
        const body = this.pending.slice(wrapper.end, close.index);
        const parsedBody = bodySegments(body);
        if (!parsedBody.valid) appendText(events, this.pending.slice(0, close.index + close.tag.length));
        else for (const segment of parsedBody.segments) {
          if (segment.type === "text") appendText(events, segment.text);
          else events.push(segment);
        }
        this.pending = this.pending.slice(close.index + close.tag.length);
        continue;
      }
      const result = invokeAt(this.pending, 0);
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

  feed(text: string): string {
    const events = this.feedEvents(text);
    return events.filter((event): event is { type: "text"; text: string } => event.type === "text").map((event) => event.text).join("");
  }

  drainCompleted(): DsmlToolCall[] {
    const calls = this.completed;
    this.completed = [];
    return calls;
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
  blurb:
    "Heals Cline's leaked DeepSeek DSML markup; remove this stage after Cline returns standard OpenAI tool calls.",
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
    if (frame !== null) {
      for (const output of this.processFrame(frame)) this.push(output);
    }
    this.healer.flushPending();
    callback();
  }

  private processFrame(frame: string): string[] {
    const parsed = parseSseData(frame);
    if (parsed.data === null || parsed.data === "[DONE]") {
      return [frame + "\n\n"];
    }
    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(parsed.data) as ChatCompletionChunk;
    } catch {
      return [frame + "\n\n"];
    }
    if (!Array.isArray(chunk.choices)) return [frame + "\n\n"];
    const hasNative = chunk.choices.some((choice) =>
      Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0,
    );
    this.nativeSeen ||= hasNative;
    const output: string[] = [];
    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (!delta || typeof delta.content !== "string") {
        const finish =
          choice.finish_reason === "stop" && this.recovered > 0 && !this.nativeSeen
            ? "tool_calls"
            : choice.finish_reason;
        output.push(serializeChunk({ ...chunk, choices: [{ ...choice, finish_reason: finish }] }));
        continue;
      }
      const events = this.healer.feedEvents(delta.content);
      const baseDelta = { ...delta };
      delete baseDelta.content;
      for (const event of events) {
        if (event.type === "text") {
          if (event.text) {
            output.push(
              serializeChunk({
                ...chunk,
                choices: [{ ...choice, delta: { ...baseDelta, content: event.text } }],
              }),
            );
          }
        } else if (!this.nativeSeen) {
          this.recovered++;
          output.push(
            serializeChunk({
              ...chunk,
              choices: [
                {
                  ...choice,
                  finish_reason: null,
                  delta: {
                    ...baseDelta,
                    tool_calls: [
                      {
                        index: this.nextIndex++,
                        id: event.call.id,
                        type: "function",
                        function: {
                          name: event.call.name,
                          arguments: event.call.arguments,
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          );
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        const finish =
          choice.finish_reason === "stop" && this.recovered > 0 && !this.nativeSeen
            ? "tool_calls"
            : choice.finish_reason;
        output.push(
          serializeChunk({
            ...chunk,
            choices: [{ ...choice, delta: baseDelta, finish_reason: finish }],
          }),
        );
      }
    }
    return output;
  }
}
