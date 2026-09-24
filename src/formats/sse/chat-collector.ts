import { SseFrameReader, parseSseData } from "./frame";

// Reconstruct a buffered Chat Completions stream from its incremental deltas.
// The stream's terminal chunk is often only metadata, so content and tool calls
// are assembled independently while retaining the provider's response shape.
export function collectChatSse(text: string): Record<string, unknown> {
  const reader = new SseFrameReader();
  const frames = reader.feed(Buffer.from(text, "utf8"));
  const tail = reader.flush();
  if (tail !== null) frames.push(tail);

  let id: string | undefined;
  let created: number | undefined;
  let model: string | undefined;
  let content = "";
  let reasoningContent = "";
  let hasContent = false;
  let hasReasoning = false;
  let finishReason: unknown;
  let hasFinishReason = false;
  let usage: unknown;
  let hasUsage = false;
  const toolCalls: Record<number, Record<string, unknown>> = {};
  const toolOrder: number[] = [];

  for (const frame of frames) {
    const { data } = parseSseData(frame);
    if (data === null || data === "[DONE]") continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error("malformed upstream Chat Completions SSE event");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("malformed upstream Chat Completions SSE event");
    const chunk = payload as Record<string, unknown>;

    if (id === undefined && typeof chunk.id === "string") id = chunk.id;
    if (created === undefined && typeof chunk.created === "number")
      created = chunk.created;
    if (model === undefined && typeof chunk.model === "string")
      model = chunk.model;
    if ("usage" in chunk && chunk.usage != null) {
      usage = chunk.usage;
      hasUsage = true;
    }

    const choices = chunk.choices;
    if (!Array.isArray(choices)) continue;
    const choice = choices[0];
    if (!choice || typeof choice !== "object" || Array.isArray(choice))
      continue;
    const c = choice as Record<string, unknown>;
    if ("finish_reason" in c && c.finish_reason != null) {
      finishReason = c.finish_reason;
      hasFinishReason = true;
    }
    const delta = c.delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    const d = delta as Record<string, unknown>;
    if (typeof d.content === "string") {
      content += d.content;
      hasContent = true;
    }
    if (typeof d.reasoning_content === "string") {
      reasoningContent += d.reasoning_content;
      hasReasoning = true;
    }
    if (!Array.isArray(d.tool_calls)) continue;
    for (const rawCall of d.tool_calls) {
      if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall))
        continue;
      const call = rawCall as Record<string, unknown>;
      const index =
        typeof call.index === "number" ? call.index : toolOrder.length;
      let target = toolCalls[index];
      if (!target) {
        target = { index, type: "function", function: {} };
        toolCalls[index] = target;
        toolOrder.push(index);
      }
      if (typeof call.id === "string" && call.id && !target.id)
        target.id = call.id;
      if (typeof call.type === "string" && call.type) target.type = call.type;
      const fn = call.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
      const functionPart = target.function as Record<string, unknown>;
      const f = fn as Record<string, unknown>;
      if (typeof f.name === "string" && f.name && !functionPart.name)
        functionPart.name = f.name;
      if (typeof f.arguments === "string")
        functionPart.arguments = `${typeof functionPart.arguments === "string" ? functionPart.arguments : ""}${f.arguments}`;
    }
  }

  const message: Record<string, unknown> = {};
  if (hasContent) message.content = content;
  if (hasReasoning) message.reasoning_content = reasoningContent;
  if (toolOrder.length)
    message.tool_calls = toolOrder.map((index) => toolCalls[index]);

  const choice: Record<string, unknown> = { index: 0, message };
  if (hasFinishReason) choice.finish_reason = finishReason;
  const response: Record<string, unknown> = {
    object: "chat.completion",
    choices: [choice],
  };
  if (id !== undefined) response.id = id;
  if (created !== undefined) response.created = created;
  if (model !== undefined) response.model = model;
  if (hasUsage) response.usage = usage;
  return response;
}
