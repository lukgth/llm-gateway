import { SseFrameReader, parseSseData } from "./frame";
import type {
  ResponseOutputItem,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "../wire";

// Reconstruct a buffered Responses stream without HTTP or gateway state. Codex
// may omit output from its terminal response and deliver it only through events.
export function collectResponsesSse(text: string): ResponsesResponse {
  const reader = new SseFrameReader();
  const frames = reader.feed(Buffer.from(text, "utf8"));
  const tail = reader.flush();
  if (tail !== null) frames.push(tail);

  const assembler = new BufferedResponsesSseAssembler();
  let terminal: ResponsesResponse | null = null;
  for (const frame of frames) {
    const { data, event } = parseSseData(frame);
    if (data === null || data === "[DONE]") continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error("malformed upstream Responses SSE event");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("malformed upstream Responses SSE event");

    const responseEvent = payload as ResponsesStreamEvent;
    const type =
      typeof responseEvent.type === "string"
        ? responseEvent.type
        : (event ?? "");
    if (type === "response.failed" || type === "error")
      throw new Error(`upstream Responses stream failed (${type})`);

    if (type === "response.completed" || type === "response.incomplete") {
      const nested = responseEvent.response;
      let response: ResponsesResponse;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        response = nested as ResponsesResponse;
      } else if (event === type && !responseEvent.type) {
        response = responseEvent as ResponsesResponse;
      } else {
        throw new Error(`${type} missing full response`);
      }
      if (response.status === "failed")
        throw new Error("upstream Responses stream failed (status: failed)");
      terminal = {
        ...response,
        status: response.status ??
          (type === "response.incomplete" ? "incomplete" : "completed"),
      };
      continue;
    }
    assembler.captureResponse(responseEvent.response);
    assembler.add(responseEvent, event);
  }

  if (terminal === null)
    throw new Error("upstream Responses stream ended before a terminal response event");

  const response = { ...assembler.metadata(), ...terminal };
  const bufferedOutput = assembler.build();
  if (
    !hasResponseOutputContent(response.output) &&
    hasResponseOutputContent(bufferedOutput)
  ) {
    response.output = bufferedOutput;
  }
  return response;
}

type BufferedContentPart = Record<string, unknown>;

function mergePart(
  current: BufferedContentPart | undefined,
  next: BufferedContentPart,
): BufferedContentPart {
  if (!current) return { ...next };
  const merged = { ...current, ...next };
  if (
    typeof current.text === "string" &&
    current.text.length > 0 &&
    (typeof next.text !== "string" || next.text.length === 0)
  ) {
    merged.text = current.text;
  }
  return merged;
}

function mergeItem(
  current: ResponseOutputItem | undefined,
  next: ResponseOutputItem,
): ResponseOutputItem {
  if (!current) {
    return {
      ...next,
      ...(Array.isArray(next.content)
        ? {
            content: next.content.map((part) => ({ ...part })),
          }
        : {}),
      ...(Array.isArray(next.summary)
        ? { summary: next.summary.map((part) => ({ ...part })) }
        : {}),
    };
  }
  const merged: ResponseOutputItem = { ...current, ...next };
  const oldContent = current.content;
  const newContent = next.content;
  if (!Array.isArray(newContent) || newContent.length === 0) {
    if (Array.isArray(oldContent)) merged.content = oldContent;
  } else {
    merged.content = newContent.map((part, index) =>
      mergePart(Array.isArray(oldContent) ? oldContent[index] : undefined, part),
    );
  }

  const oldSummary = current.summary;
  const newSummary = next.summary;
  if (!Array.isArray(newSummary) || newSummary.length === 0) {
    if (Array.isArray(oldSummary)) merged.summary = oldSummary;
  } else {
    merged.summary = newSummary.map((part, index) =>
      mergePart(Array.isArray(oldSummary) ? oldSummary[index] : undefined, part),
    ) as Array<{ type: string; text: string }>;
  }

  if (
    typeof current.arguments === "string" &&
    current.arguments.length > 0 &&
    (typeof next.arguments !== "string" || next.arguments.length === 0)
  ) {
    merged.arguments = current.arguments;
  }
  return merged;
}
function hasResponseOutputContent(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  return output.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as ResponseOutputItem;
    if (item.type === "message") {
      return (
        Array.isArray(item.content) &&
        item.content.some(
          (part) =>
            (typeof part.text === "string" && part.text.length > 0) ||
            (typeof part.refusal === "string" && part.refusal.length > 0),
        )
      );
    }
    if (item.type === "function_call") {
      return (
        (typeof item.call_id === "string" && item.call_id.length > 0) ||
        (typeof item.name === "string" && item.name.length > 0) ||
        (typeof item.arguments === "string" && item.arguments.length > 0)
      );
    }
    if (item.type === "reasoning") {
      return (
        (typeof item.encrypted_content === "string" &&
          item.encrypted_content.length > 0) ||
        (Array.isArray(item.summary) &&
          item.summary.some(
            (part) => typeof part.text === "string" && part.text.length > 0,
          ))
      );
    }
    return true;
  });
}

class BufferedResponsesSseAssembler {
  private readonly output: Array<ResponseOutputItem | undefined> = [];
  private readonly itemIndexes = new Map<string, number>();
  private response: Partial<ResponsesResponse> = {};

  captureResponse(response: unknown): void {
    if (response && typeof response === "object" && !Array.isArray(response)) {
      Object.assign(this.response, response);
    }
  }

  add(event: ResponsesStreamEvent, eventName: string | null): void {
    const type =
      typeof event.type === "string" ? event.type : (eventName ?? "");
    if (
      type === "response.output_item.added" ||
      type === "response.output_item.done"
    ) {
      if (!event.item || typeof event.item !== "object") return;
      const item = event.item as ResponseOutputItem;
      const index = this.outputIndex(event);
      this.output[index] = mergeItem(this.output[index], item);
      this.rememberItem(index, item);
      return;
    }

    if (
      type === "response.content_part.added" ||
      type === "response.content_part.done"
    ) {
      if (!event.part || typeof event.part !== "object") return;
      const part = event.part as BufferedContentPart;
      const index = this.outputIndex(event);
      const item = this.ensureItem(index, "message");
      const content = Array.isArray(item.content) ? [...item.content] : [];
      const contentIndex = this.index(event.content_index, 0);
      content[contentIndex] = mergePart(content[contentIndex], part);
      item.content = content;
      return;
    }

    if (
      type === "response.output_text.delta" ||
      type === "response.output_text.done" ||
      type === "response.text.done"
    ) {
      const index = this.outputIndex(event);
      const item = this.ensureItem(index, "message");
      const content = Array.isArray(item.content) ? [...item.content] : [];
      const contentIndex = this.index(event.content_index, 0);
      const current = content[contentIndex] ?? {
        type: "output_text",
        text: "",
      };
      const value =
        type === "response.output_text.delta" ? event.delta : event.text;
      if (typeof value === "string") {
        current.text =
          type === "response.output_text.delta"
            ? `${typeof current.text === "string" ? current.text : ""}${value}`
            : value || current.text || "";
      }
      if (typeof current.type !== "string") current.type = "output_text";
      content[contentIndex] = current;
      item.content = content;
      return;
    }

    if (
      type === "response.function_call_arguments.delta" ||
      type === "response.function_call_arguments.done"
    ) {
      const index = this.outputIndex(event);
      const item = this.ensureItem(index, "function_call");
      const value =
        type === "response.function_call_arguments.delta"
          ? event.delta
          : event.arguments;
      if (typeof value === "string") {
        item.arguments =
          type === "response.function_call_arguments.delta"
            ? `${typeof item.arguments === "string" ? item.arguments : ""}${value}`
            : value || item.arguments || "";
      }
    }
  }

  build(): ResponseOutputItem[] {
    return this.output.filter(
      (item): item is ResponseOutputItem => item !== undefined,
    );
  }
  metadata(): Partial<ResponsesResponse> {
    return this.response;
  }

  private outputIndex(event: ResponsesStreamEvent): number {
    if (typeof event.item_id === "string") {
      const known = this.itemIndexes.get(event.item_id);
      if (known !== undefined) return known;
    }
    return this.index(event.output_index, 0);
  }

  private index(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : fallback;
  }

  private ensureItem(index: number, type: string): ResponseOutputItem {
    let item = this.output[index];
    if (!item) {
      item =
        type === "message"
          ? { type, role: "assistant", content: [] }
          : { type, arguments: "" };
      this.output[index] = item;
    }
    return item;
  }

  private rememberItem(index: number, item: ResponseOutputItem): void {
    if (typeof item.id === "string") this.itemIndexes.set(item.id, index);
  }
}
