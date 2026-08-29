import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DsmlToolCallHealer,
  DsmlChatStreamTransform,
  parseDsmlToolCalls,
} from "./dsml";

const invoke = (body: string, pipes = "|") =>
  `<${pipes}DSML${pipes}invoke name="mcp__ao_mcp_search_works">${body}<${pipes}DSML${pipes}/invoke>`;
const parameter = (name: string, value: string, stringValue = "true", pipes = "|") =>
  `<${pipes}DSML${pipes}parameter name="${name}" string="${stringValue}">${value}<${pipes}DSML${pipes}/parameter>`;

test("parses fullwidth AO3 invoke and false JSON parameters", () => {
  const text = `before ${invoke(
    parameter("rating", '["Mature"]', "false", "｜") +
      parameter("query", "a > b\n2>&1", "true", "｜"),
    "｜",
  )} after`;
  const parsed = parseDsmlToolCalls(text);
  assert.equal(parsed.text, "before  after");
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, "mcp__ao_mcp_search_works");
  assert.deepEqual(JSON.parse(parsed.calls[0].arguments), {
    rating: ["Mature"],
    query: "a > b\n2>&1",
  });
  assert.match(parsed.calls[0].id, /^call_[0-9a-f]{24}$/);
});

test("parses ASCII invokes, coercion, wrappers, and multiple calls", () => {
  const body = [
    parameter("count", "42", "false"),
    parameter("enabled", "true", "false"),
    parameter("options", '{"x":1}', "false"),
  ].join("");
  const text = `x<|DSML|tool_calls>${invoke(body)}${invoke(parameter("raw", "  keep  "))}<|DSML|/tool_calls>y`;
  const parsed = parseDsmlToolCalls(text);
  assert.equal(parsed.text, "xy");
  assert.equal(parsed.calls.length, 2);
  assert.deepEqual(JSON.parse(parsed.calls[0].arguments), {
    count: 42,
    enabled: true,
    options: { x: 1 },
  });
  assert.deepEqual(JSON.parse(parsed.calls[1].arguments), { raw: "  keep  " });
});

test("healer preserves text/call/text order across arbitrary splits", () => {
  const source = `a${invoke(parameter("q", "x"))}b`;
  for (let split = 0; split <= source.length; split++) {
    const healer = new DsmlToolCallHealer();
    const events = [
      ...healer.feedEvents(source.slice(0, split)),
      ...healer.feedEvents(source.slice(split)),
    ];
    assert.deepEqual(
      events.map((event) => event.type === "text" ? event.text : event.call.name),
      ["a", "mcp__ao_mcp_search_works", "b"],
      `split ${split}`,
    );
    assert.equal(healer.drainCompleted().length, 1);
  }
});

test("healer discards incomplete recognized DSML but preserves ordinary prose", () => {
  const healer = new DsmlToolCallHealer();
  assert.equal(healer.feed("ordinary "), "ordinary ");
  assert.equal(healer.feed(invoke(parameter("x", "unterminated")).slice(0, -9)), "");
  assert.equal(healer.flushPending(), "");
  assert.equal(healer.drainCompleted().length, 0);
  assert.equal(parseDsmlToolCalls("mention <DSML> plainly").text, "mention <DSML> plainly");
});

test("stream transform emits cleaned text and recovered tool call", async () => {
  const transform = new DsmlChatStreamTransform();
  const output: Buffer[] = [];
  transform.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const content = `left ${invoke(parameter("rating", '["Mature"]', "false"))} right`;
  const frames = [
    `data: ${JSON.stringify({ id: "r", model: "m", choices: [{ index: 0, delta: { content: content.slice(0, 17) }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "r", model: "m", choices: [{ index: 0, delta: { content: content.slice(17) }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "r", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  transform.end(Buffer.from(frames.join("")));
  await new Promise<void>((resolve, reject) => {
    transform.once("end", resolve);
    transform.once("error", reject);
  });
  const parsed = output
    .join("")
    .split("\n\n")
    .filter(Boolean)
    .filter((frame) => !frame.endsWith("[DONE]"))
    .map((frame) => JSON.parse(frame.slice(6)));
  const deltas = parsed.flatMap((chunk) => chunk.choices ?? []);
  assert.equal(deltas[0].delta.content, "left ");
  assert.equal(deltas[1].delta.tool_calls[0].function.name, "mcp__ao_mcp_search_works");
  assert.deepEqual(JSON.parse(deltas[1].delta.tool_calls[0].function.arguments), { rating: ["Mature"] });
  assert.equal(deltas.at(-1).finish_reason, "tool_calls");
  assert.ok(!output.join("").includes("DSML"));
});

test("stream transform keeps native tool calls as source of truth", async () => {
  const transform = new DsmlChatStreamTransform();
  const output: Buffer[] = [];
  transform.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: invoke(parameter("x", "1")), tool_calls: [{ index: 0, id: "native", type: "function", function: { name: "native", arguments: "{}" } }] }, finish_reason: "stop" }] })}\n\n`;
  transform.end(Buffer.from(frame + "data: [DONE]\n\n"));
  await new Promise<void>((resolve, reject) => {
    transform.once("end", resolve);
    transform.once("error", reject);
  });
  const all = output.join("");
  assert.equal((all.match(/"tool_calls"/g) ?? []).length, 1);
  assert.ok(!all.includes("DSML"));
});
