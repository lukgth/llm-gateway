// =============================================================================
// xxHash64 — pure-TypeScript implementation (no runtime dependencies)
// =============================================================================
// Reference:
//   https://github.com/Cyan4973/xxHash/blob/dev/xxhash.h
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/claude_signing.go

const MASK64 = 0xffffffffffffffffn;

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

/** Mask the xxHash64 result to its lower 20 bits (= 5 hex chars). */
export const MASK_20 = 0xfffffn;

function rotl64(x: bigint, r: number): bigint {
  return ((x << BigInt(r)) | (x >> BigInt(64 - r))) & MASK64;
}

function read64le(data: Uint8Array, p: number): bigint {
  return (
    (BigInt(data[p]) |
      (BigInt(data[p + 1]) << 8n) |
      (BigInt(data[p + 2]) << 16n) |
      (BigInt(data[p + 3]) << 24n) |
      (BigInt(data[p + 4]) << 32n) |
      (BigInt(data[p + 5]) << 40n) |
      (BigInt(data[p + 6]) << 48n) |
      (BigInt(data[p + 7]) << 56n)) &
    MASK64
  );
}

function read32le(data: Uint8Array, p: number): bigint {
  // >>> 0 keeps the 32-bit value unsigned before widening to BigInt.
  return BigInt(
    (data[p] |
      (data[p + 1] << 8) |
      (data[p + 2] << 16) |
      (data[p + 3] << 24)) >>>
      0,
  );
}

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + ((input * PRIME64_2) & MASK64)) & MASK64;
  acc = rotl64(acc, 31);
  return (acc * PRIME64_1) & MASK64;
}

function mergeRound(acc: bigint, input: bigint): bigint {
  const val = round(0n, input);
  acc = (acc ^ val) & MASK64;
  return (((acc * PRIME64_1) & MASK64) + PRIME64_4) & MASK64;
}

/**
 * Canonical xxHash64 of `data` with a 64-bit seed assembled from two 32-bit
 * halves (matching the hash-wasm `createXXHash64(seedLow, seedHigh)` calling
 * convention used by the plugin). Returns the raw 64-bit digest as a BigInt.
 */
export function xxHash64(
  data: Uint8Array,
  seedHigh: number,
  seedLow: number,
): bigint {
  const seed =
    ((BigInt(seedHigh >>> 0) << 32n) | BigInt(seedLow >>> 0)) & MASK64;
  return xxHash64WithSeed(data, seed);
}

function xxHash64WithSeed(data: Uint8Array, seed: bigint): bigint {
  const len = data.length;
  let p = 0;
  let h: bigint;

  if (len >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK64;
    let v2 = (seed + PRIME64_2) & MASK64;
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME64_1) & MASK64;
    const limit = len - 32;
    do {
      v1 = round(v1, read64le(data, p));
      p += 8;
      v2 = round(v2, read64le(data, p));
      p += 8;
      v3 = round(v3, read64le(data, p));
      p += 8;
      v4 = round(v4, read64le(data, p));
      p += 8;
    } while (p <= limit);

    h =
      (rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18)) &
      MASK64;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = (seed + PRIME64_5) & MASK64;
  }

  h = (h + BigInt(len)) & MASK64;

  while (p + 8 <= len) {
    const k1 = round(0n, read64le(data, p));
    h = (h ^ k1) & MASK64;
    h = (((rotl64(h, 27) * PRIME64_1) & MASK64) + PRIME64_4) & MASK64;
    p += 8;
  }
  if (p + 4 <= len) {
    h = (h ^ ((read32le(data, p) * PRIME64_1) & MASK64)) & MASK64;
    h = (((rotl64(h, 23) * PRIME64_2) & MASK64) + PRIME64_3) & MASK64;
    p += 4;
  }
  while (p < len) {
    h = (h ^ ((BigInt(data[p]) * PRIME64_5) & MASK64)) & MASK64;
    h = (rotl64(h, 11) * PRIME64_1) & MASK64;
    p += 1;
  }

  h ^= h >> 33n;
  h = (h * PRIME64_2) & MASK64;
  h ^= h >> 29n;
  h = (h * PRIME64_3) & MASK64;
  h ^= h >> 32n;
  return h;
}

/** Hex (16-char lowercase) digest form of {@link xxHash64}. */
export function xxHash64Hex(
  data: Uint8Array,
  seedHigh: number,
  seedLow: number,
): string {
  return xxHash64(data, seedHigh, seedLow).toString(16).padStart(16, "0");
}
