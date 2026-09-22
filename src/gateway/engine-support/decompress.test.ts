import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, brotliCompressSync, deflateSync, zstdCompressSync } from "zlib";
import type { IncomingMessage } from "http";
import { readErrorBody } from "./utils";

// Minimal async-iterable stand-in for IncomingMessage - readErrorBody only
// consumes `headers` and iterates the body as chunks.
function fakeUpstream(
  body: Buffer,
  contentEncoding?: string,
): IncomingMessage {
  return {
    headers: contentEncoding ? { "content-encoding": contentEncoding } : {},
    [Symbol.asyncIterator]: async function* () {
      yield body;
    },
  } as unknown as IncomingMessage;
}

test("readErrorBody decompresses gzip, br, deflate, and zstd bodies", async () => {
  const text = JSON.stringify({ hello: "world" });
  const raw = Buffer.from(text, "utf8");

  assert.equal(await readErrorBody(fakeUpstream(gzipSync(raw), "gzip")), text);
  assert.equal(
    await readErrorBody(fakeUpstream(brotliCompressSync(raw), "br")),
    text,
  );
  assert.equal(
    await readErrorBody(fakeUpstream(deflateSync(raw), "deflate")),
    text,
  );
  assert.equal(
    await readErrorBody(fakeUpstream(zstdCompressSync(raw), "zstd")),
    text,
  );
});

test("readErrorBody passes identity/unencoded bodies through unchanged", async () => {
  const text = JSON.stringify({ hello: "world" });
  assert.equal(
    await readErrorBody(fakeUpstream(Buffer.from(text, "utf8"))),
    text,
  );
});
