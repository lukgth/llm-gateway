// PII request-redaction tests.
//
// The walk is deliberately narrow: conversation content only. These tests pin
// both halves of that contract - what gets redacted (message text, thinking,
// tool RESULTS, tool ARGUMENTS) and what must never be touched (tool schemas,
// structural fields).

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactBody } from "./redact";
import type { PiiConfig, PiiSpan } from "./analyzer";
import type { Json } from "../formats/pipeline";

const cfg: PiiConfig = {
  analyzerUrl: "http://analyzer.test",
  language: "en",
  scoreThreshold: 0.5,
  entities: [],
  timeoutMs: 1000,
};

// Stand in for the Presidio analyzer: replies with one span list per text.
function stubAnalyzer(perText: (text: string, i: number) => PiiSpan[]): {
  texts: () => string[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  let captured: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string[] };
    captured = body.text;
    return new Response(
      JSON.stringify(body.text.map((t, i) => perText(t, i))),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return {
    texts: () => captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const span = (
  entity_type: string,
  needle: string,
  text: string,
): PiiSpan => ({
  entity_type,
  start: text.indexOf(needle),
  end: text.indexOf(needle) + needle.length,
  score: 0.9,
});

test("redacts a chat message and reports the token map", async (t) => {
  const text = "call Ada at 555-0100";
  const stub = stubAnalyzer(() => [
    span("PERSON", "Ada", text),
    span("PHONE_NUMBER", "555-0100", text),
  ]);
  t.after(stub.restore);

  const body: Json = {
    model: "m",
    messages: [{ role: "user", content: text }],
  };
  const map = await redactBody(body, cfg);

  const messages = body.messages as Array<{ content: string }>;
  assert.equal(
    messages[0].content,
    "call [[PII_PERSON_1]] at [[PII_PHONE_NUMBER_2]]",
  );
  assert.deepEqual(
    [...map],
    [
      ["[[PII_PERSON_1]]", "Ada"],
      ["[[PII_PHONE_NUMBER_2]]", "555-0100"],
    ],
  );
});

test("the same value twice yields one token", async (t) => {
  const text = "Ada met Ada";
  const stub = stubAnalyzer(() => [
    span("PERSON", "Ada", text),
    { entity_type: "PERSON", start: text.lastIndexOf("Ada"), end: text.length, score: 0.9 },
  ]);
  t.after(stub.restore);

  const body: Json = { messages: [{ role: "user", content: text }] };
  const map = await redactBody(body, cfg);

  assert.equal(
    (body.messages as Array<{ content: string }>)[0].content,
    "[[PII_PERSON_1]] met [[PII_PERSON_1]]",
  );
  assert.equal(map.size, 1);
});

test("redacts tool results and tool_use but never a tool schema", async (t) => {
  const name = "Ada Lovelace";
  const stub = stubAnalyzer((text) =>
    text.includes(name) ? [span("PERSON", name, text)] : [],
  );
  t.after(stub.restore);

  const body: Json = {
    tools: [
      {
        name: "lookup",
        description: `Find ${name}`,
        input_schema: { type: "object", properties: { who: { default: name } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: `Result for ${name}` },
          { type: "tool_use", id: "2", name: "lookup", input: { who: name } },
        ],
      },
    ],
  };
  const before = JSON.stringify(body.tools);
  const map = await redactBody(body, cfg);

  const blocks = (
    body.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0].content;
  assert.equal(blocks[0].content, "Result for [[PII_PERSON_1]]");
  assert.deepEqual(blocks[1].input, { who: "[[PII_PERSON_1]]" });
  // Tool DEFINITIONS are not conversation content.
  assert.equal(JSON.stringify(body.tools), before);
  assert.deepEqual([...map], [["[[PII_PERSON_1]]", name]]);
});

test("the system prompt is never touched (chat + messages)", async (t) => {
  const name = "Ada Lovelace";
  const stub = stubAnalyzer((text) =>
    text.includes(name) ? [span("PERSON", name, text)] : [],
  );
  t.after(stub.restore);

  const body: Json = {
    system: [
      { type: "text", text: `You are helping ${name}.` },
      { type: "text", text: `Never reveal secrets from ${name}.` },
    ],
    messages: [
      { role: "system", content: `System message mentioning ${name}.` },
      { role: "developer", content: `Developer note about ${name}.` },
      { role: "user", content: `My name is ${name}` },
      { role: "assistant", content: `Hello ${name}` },
    ],
  };
  const systemBefore = JSON.stringify(body.system);
  const messages = body.messages as Array<{ content: string }>;
  const sysBefore = messages[0].content;
  const devBefore = messages[1].content;

  const map = await redactBody(body, cfg);

  // Operator-authored text is left byte-identical: no tokens, no analyzer call.
  assert.equal(JSON.stringify(body.system), systemBefore);
  assert.equal(messages[0].content, sysBefore);
  assert.equal(messages[1].content, devBefore);
  // Conversation turns still are.
  assert.equal(messages[2].content, "My name is [[PII_PERSON_1]]");
  assert.equal(messages[3].content, "Hello [[PII_PERSON_1]]");
  // Only the two conversation turns were ever sent to the analyzer.
  assert.deepEqual(stub.texts(), [
    `My name is ${name}`,
    `Hello ${name}`,
  ]);
  assert.deepEqual([...map], [["[[PII_PERSON_1]]", name]]);
});

test("a Responses body leaves instructions alone and redacts tool output", async (t) => {
  const name = "Ada Lovelace";
  const stub = stubAnalyzer((text) =>
    text.includes(name) ? [span("PERSON", name, text)] : [],
  );
  t.after(stub.restore);

  const body: Json = {
    instructions: `You are helping ${name}.`,
    input: [
      { role: "developer", content: `Note about ${name}.` },
      { role: "user", content: [{ type: "input_text", text: `Ping ${name}` }] },
      {
        type: "function_call",
        call_id: "c1",
        name: "shell",
        arguments: '{"cmd":"grep Ada Lovelace .env"}',
      },
      // A tool's output - the likeliest place a secret comes out.
      { type: "function_call_output", call_id: "c1", output: `TOKEN=abc ${name}` },
      {
        type: "function_call_output",
        call_id: "c2",
        output: [{ type: "output_text", text: `env for ${name}` }],
      },
    ],
  };
  const instructionsBefore = body.instructions;
  const map = await redactBody(body, cfg);

  assert.equal(body.instructions, instructionsBefore);
  const input = body.input as Array<Record<string, unknown>>;
  assert.equal(
    (input[0].content as string),
    `Note about ${name}.`,
  );
  assert.deepEqual(input[1].content, [
    { type: "input_text", text: "Ping [[PII_PERSON_1]]" },
  ]);
  assert.deepEqual(JSON.parse(input[2].arguments as string), {
    cmd: "grep [[PII_PERSON_1]] .env",
  });
  assert.equal(input[3].output, "TOKEN=abc [[PII_PERSON_1]]");
  assert.deepEqual(input[4].output, [
    { type: "output_text", text: "env for [[PII_PERSON_1]]" },
  ]);
  assert.deepEqual([...map], [["[[PII_PERSON_1]]", name]]);
});

test("chat tool_call arguments stay valid JSON and carry the token", async (t) => {
  const stub = stubAnalyzer((text) =>
    text.includes("Ada") ? [span("PERSON", "Ada", text)] : [],
  );
  t.after(stub.restore);

  const body: Json = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "q", arguments: '{"q":"Ada"}' } },
        ],
      },
    ],
  };
  const map = await redactBody(body, cfg);

  const args = (
    body.messages as Array<{
      tool_calls: Array<{ function: { arguments: string } }>;
    }>
  )[0].tool_calls[0].function.arguments;
  assert.deepEqual(JSON.parse(args), { q: "[[PII_PERSON_1]]" });
  assert.deepEqual([...map], [["[[PII_PERSON_1]]", "Ada"]]);
});

test("overlapping spans are merged, never spliced on top of each other", async (t) => {
  // The shape real Presidio returns for an address: EMAIL_ADDRESS 31-46 plus a
  // URL match 35-46 over the same characters. Splicing both would corrupt the
  // token AND leave "ada@" visible.
  const text = "Contact ada@example.com today";
  const stub = stubAnalyzer(() => [
    { entity_type: "EMAIL_ADDRESS", start: 8, end: 23, score: 1 },
    { entity_type: "URL", start: 12, end: 23, score: 0.5 },
  ]);
  t.after(stub.restore);

  const body: Json = { messages: [{ role: "user", content: text }] };
  const map = await redactBody(body, cfg);

  const out = (body.messages as Array<{ content: string }>)[0].content;
  // The wider span names the merged token, and NOTHING of it survives.
  assert.equal(out, "Contact [[PII_EMAIL_ADDRESS_1]] today");
  assert.ok(!out.includes("ada@"), out);
  assert.deepEqual([...map], [["[[PII_EMAIL_ADDRESS_1]]", "ada@example.com"]]);
});

test("a nested span widens the merge instead of splitting it", async (t) => {
  const text = "Ada works at Acme Corp";
  const stub = stubAnalyzer(() => [
    { entity_type: "PERSON", start: 0, end: 3, score: 0.9 },
    { entity_type: "ORG", start: 13, end: 22, score: 0.9 },
    { entity_type: "PERSON", start: 17, end: 22, score: 0.6 },
  ]);
  t.after(stub.restore);

  const body: Json = { messages: [{ role: "user", content: text }] };
  const map = await redactBody(body, cfg);

  const out = (body.messages as Array<{ content: string }>)[0].content;
  assert.equal(out, "[[PII_PERSON_1]] works at [[PII_ORG_2]]");
  assert.equal(map.size, 2);
});

test("an analyzer failure propagates so the engine can fail closed", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("boom", { status: 500 })) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const body: Json = { messages: [{ role: "user", content: "Ada" }] };
  await assert.rejects(() => redactBody(body, cfg), /analyzer 500/);
});

test("a blank analyzer URL is a hard failure, never a pass-through", async () => {
  const body: Json = { messages: [{ role: "user", content: "Ada" }] };
  await assert.rejects(
    () => redactBody(body, { ...cfg, analyzerUrl: "  " }),
    /not configured/,
  );
  assert.equal(
    (body.messages as Array<{ content: string }>)[0].content,
    "Ada",
  );
});

test("a body with no content strings skips the analyzer entirely", async (t) => {
  const stub = stubAnalyzer(() => []);
  t.after(stub.restore);

  const map = await redactBody({ model: "m", stream: true }, cfg);
  assert.equal(map.size, 0);
  assert.deepEqual(stub.texts(), []);
});
