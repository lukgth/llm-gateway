import { test } from "node:test";
import assert from "node:assert/strict";
import { MASK_20, xxHash64 } from "./xxhash64";

const hex = (value: bigint): string => value.toString(16).padStart(16, "0");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

test("xxHash64 matches the canonical vectors", () => {
  // Published XXH64 test vectors (seed 0).
  assert.equal(hex(xxHash64(enc(""), 0, 0)), "ef46db3751d8e999");
  assert.equal(hex(xxHash64(enc("abc"), 0, 0)), "44bc2cf5ad770999");
});

test("xxHash64 is deterministic and stays inside 64 bits", () => {
  const payload = enc("x".repeat(64));
  const first = xxHash64(payload, 0x12345678, 0x9abcdef0);
  assert.equal(first, xxHash64(payload, 0x12345678, 0x9abcdef0));
  assert.ok(first >= 0n && first <= 0xffffffffffffffffn);
});

test("xxHash64 seed halves and input bytes both matter", () => {
  const payload = enc("model-attestation");
  const base = xxHash64(payload, 0, 0);
  assert.notEqual(xxHash64(payload, 1, 0), base, "high seed half is used");
  assert.notEqual(xxHash64(payload, 0, 1), base, "low seed half is used");
  const mutated = enc("model-attestatioN");
  assert.notEqual(xxHash64(mutated, 0, 0), base, "single byte change matters");
});

test("MASK_20 keeps exactly the lower 20 bits of the digest", () => {
  const masked = xxHash64(enc("abc"), 0, 0) & MASK_20;
  assert.ok(masked <= 0xfffffn);
  assert.equal(masked.toString(16).padStart(5, "0").length, 5);
});
