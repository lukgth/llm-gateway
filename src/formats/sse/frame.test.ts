// Regression: a chunk boundary landing mid multi-byte UTF-8 sequence must not
// corrupt the stream. The old per-chunk `toString("utf8")` baked U+FFFD into
// the buffer (observed as `���` for em dashes / curly quotes on providers that
// stream tiny per-token deltas, e.g. HyperCharm).
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { SseFrameReader } from "./frame";

// Split `text` into byte chunks at every possible boundary offset, shifting
// each test's split point so every multi-byte sequence gets sliced somewhere.
function feedAtSplits(text: string, splitOffsets: number[]): string[] {
  const bytes = Buffer.from(text, "utf8");
  const out: string[] = [];
  for (const off of splitOffsets) {
    const reader = new SseFrameReader();
    out.push(...reader.feed(bytes.subarray(0, off)));
    out.push(...reader.feed(bytes.subarray(off)));
    const tail = reader.flush();
    if (tail !== null) out.push(tail);
  }
  return out;
}

describe("SseFrameReader utf8 chunk boundaries", () => {
  test("multi-byte char split across chunks survives", () => {
    // em dash (3 bytes) + U+2019 (3 bytes), one event per line
    const text = 'data: {"c":"a—b’s"}\n\ndata: {"c":"done"}\n\n';
    const events = feedAtSplits(
      text,
      Array.from({ length: Buffer.byteLength(text) - 1 }, (_, i) => i + 1),
    );
    assert.ok(events.length >= 2);
    assert.match(events[0], /a—b’s/);
    assert.match(events[events.length - 1], /done/);
    for (const e of events) assert.ok(!e.includes("\uFFFD"), e);
  });

  test("split inside the \\n\\n separator still frames correctly", () => {
    const reader = new SseFrameReader();
    assert.deepEqual(reader.feed(Buffer.from('data: {"x":1}\n', "utf8")), []);
    assert.deepEqual(reader.feed(Buffer.from("\ndata: next\n\n", "utf8")), [
      'data: {"x":1}',
      "data: next",
    ]);
  });

  test("flush decodes trailing partial block", () => {
    const reader = new SseFrameReader();
    assert.deepEqual(reader.feed(Buffer.from("data: —é", "utf8")), []);
    assert.equal(reader.flush(), "data: —é");
    assert.equal(reader.flush(), null);
  });

  test("invisible chars are stripped from complete blocks", () => {
    const reader = new SseFrameReader();
    const events = reader.feed(
      Buffer.from("data: a\u200Bb\n\ndata: c\uFEFFd\n\n", "utf8"),
    );
    assert.deepEqual(events, ["data: ab", "data: cd"]);
  });
});
