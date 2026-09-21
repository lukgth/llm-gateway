// PII token re-hydrator tests.
//
// The re-hydrator is byte-level: a token is pure ASCII inside a JSON string, so
// it can be spliced without parsing. That means one implementation covers every
// client format and every text field - and, critically, it must never leak half
// a token when a chunk boundary lands inside one.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Transform } from "stream";
import {
  jsonEscape,
  piiToken,
  rehydrateBuffer,
  rehydrateTransform,
} from "./tokens";

// Drive bytes through a transform and collect the emitted string.
function run(t: Transform, chunks: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    t.on("data", (c) => (out += c.toString("utf8")));
    t.on("end", () => resolve(out));
    t.on("error", reject);
    for (const c of chunks) t.write(Buffer.from(c, "utf8"));
    t.end();
  });
}

const map = () => new Map([["[[PII_PERSON_1]]", "Ada Lovelace"]]);

test("piiToken builds an ASCII token from any entity type", () => {
  assert.equal(piiToken("PERSON", 1), "[[PII_PERSON_1]]");
  assert.equal(piiToken("phone_number", 12), "[[PII_PHONE_NUMBER_12]]");
});

test("splices a token split across three chunk boundaries", async () => {
  const out = await run(rehydrateTransform(map()), [
    'data: {"choices":[{"delta":{"content":"Hi [[PI',
    "I_PERSON_1]] there",
    '"}}]}\n\n',
  ]);
  assert.equal(
    out,
    'data: {"choices":[{"delta":{"content":"Hi Ada Lovelace there"}}]}\n\n',
  );
  assert.ok(!out.includes("[[PII_"));
});

test("spliced bytes are JSON-escaped, so the payload stays valid JSON", async () => {
  const m = new Map([["[[PII_PERSON_1]]", jsonEscape('He said "hi"\nnow')]]);
  const out = await run(rehydrateTransform(m), [
    'data: {"content":"[[PII_PERSON_1]]"}\n\n',
  ]);
  const payload = out.slice("data: ".length, -2);
  assert.deepEqual(JSON.parse(payload), { content: 'He said "hi"\nnow' });
});

test("a stray unterminated marker is emitted verbatim on flush", async () => {
  const out = await run(rehydrateTransform(map()), [
    'data: {"content":"oops [[PII_PERSON_1',
  ]);
  assert.equal(out, 'data: {"content":"oops [[PII_PERSON_1');
});

test("a trailing partial marker is held, not leaked", async () => {
  const t = rehydrateTransform(map());
  const seen: string[] = [];
  t.on("data", (c) => seen.push(c.toString("utf8")));
  t.write(Buffer.from('data: {"content":"', "utf8"));
  t.write(Buffer.from("[[PI", "utf8"));
  assert.equal(seen.join(""), 'data: {"content":"');
  t.end();
});

test("a hold larger than the cap is released instead of buffering forever", async () => {
  const out = await run(rehydrateTransform(map()), [
    "[[PII_" + "x".repeat(4096),
  ]);
  assert.equal(out, "[[PII_" + "x".repeat(4096));
});

test("an empty map passes bytes through untouched", async () => {
  const chunk = 'data: {"content":"[[PII_PERSON_1]]"}\n\n';
  assert.equal(await run(rehydrateTransform(undefined), [chunk]), chunk);
  assert.equal(await run(rehydrateTransform(new Map()), [chunk]), chunk);
});

test("rehydrateBuffer resolves complete tokens and keeps unknown markers", () => {
  const m = map();
  assert.equal(
    rehydrateBuffer(
      Buffer.from('{"a":"[[PII_PERSON_1]]","b":"[[PII_OTHER_9]]"}'),
      m,
    ).toString(),
    '{"a":"Ada Lovelace","b":"[[PII_OTHER_9]]"}',
  );
  const untouched = Buffer.from("plain bytes");
  assert.equal(rehydrateBuffer(untouched, undefined), untouched);
});
