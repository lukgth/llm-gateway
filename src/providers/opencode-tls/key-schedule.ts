// TLS 1.3 key schedule, exactly as RFC 8446 §7.1 defines it.
//
// Implemented with explicit HMAC calls on purpose: `crypto.hkdfSync` runs
// HKDF-Extract *and* HKDF-Expand, so using it for either half silently changes
// the derived secret (a mistake that only shows up as an undecryptable record).

import crypto, { type CipherGCM, type DecipherGCM } from "node:crypto";

export type HashName = "sha256" | "sha384";

export interface CipherSuite {
  id: number;
  name: string;
  /** AEAD key length in bytes. */
  keyLength: number;
  /** AEAD algorithm passed to node:crypto. */
  algorithm: string;
  hash: HashName;
  /** Nonce length; every TLS 1.3 suite uses 12. */
  ivLength: number;
}

export const CIPHER_SUITES: Record<number, CipherSuite> = {
  0x1301: {
    id: 0x1301,
    name: "TLS_AES_128_GCM_SHA256",
    keyLength: 16,
    algorithm: "aes-128-gcm",
    hash: "sha256",
    ivLength: 12,
  },
  0x1302: {
    id: 0x1302,
    name: "TLS_AES_256_GCM_SHA384",
    keyLength: 32,
    algorithm: "aes-256-gcm",
    hash: "sha384",
    ivLength: 12,
  },
  0x1303: {
    id: 0x1303,
    name: "TLS_CHACHA20_POLY1305_SHA256",
    keyLength: 32,
    algorithm: "chacha20-poly1305",
    hash: "sha256",
    ivLength: 12,
  },
};

const digestLength = (hash: HashName): number => (hash === "sha384" ? 48 : 32);

export function hash(hashName: HashName, data: Buffer): Buffer {
  return crypto.createHash(hashName).update(data).digest();
}

/** HKDF-Extract(salt, IKM). */
export function hkdfExtract(
  hashName: HashName,
  salt: Buffer,
  ikm: Buffer,
): Buffer {
  return crypto.createHmac(hashName, salt).update(ikm).digest();
}

/** HKDF-Expand(PRK, info, length). */
export function hkdfExpand(
  hashName: HashName,
  prk: Buffer,
  info: Buffer,
  length: number,
): Buffer {
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let produced = 0;
  for (let counter = 1; produced < length; counter++) {
    previous = crypto
      .createHmac(hashName, prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    chunks.push(previous);
    produced += previous.length;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

/** HKDF-Expand-Label(secret, label, context, length). */
export function expandLabel(
  hashName: HashName,
  secret: Buffer,
  label: string,
  context: Buffer,
  length: number,
): Buffer {
  const full = Buffer.from(`tls13 ${label}`, "utf8");
  const info = Buffer.concat([
    Buffer.from([length >> 8, length & 0xff, full.length]),
    full,
    Buffer.from([context.length]),
    context,
  ]);
  return hkdfExpand(hashName, secret, info, length);
}

/** Derive-Secret(secret, label, transcript-hash). */
export function deriveSecret(
  hashName: HashName,
  secret: Buffer,
  label: string,
  transcriptHash: Buffer,
): Buffer {
  return expandLabel(
    hashName,
    secret,
    label,
    transcriptHash,
    digestLength(hashName),
  );
}

export interface TrafficKeys {
  key: Buffer;
  iv: Buffer;
  sequence: number;
}

/** Traffic keys for one direction at one generation. */
export function trafficKeys(
  hashName: HashName,
  secret: Buffer,
  keyLength: number,
  ivLength: number,
): TrafficKeys {
  return {
    key: expandLabel(hashName, secret, "key", Buffer.alloc(0), keyLength),
    iv: expandLabel(hashName, secret, "iv", Buffer.alloc(0), ivLength),
    sequence: 0,
  };
}

/** TLS 1.3 nonce: the static IV XORed with the 64-bit record sequence. */
export function nonceFor(keys: TrafficKeys): Buffer {
  const nonce = Buffer.from(keys.iv);
  let sequence = BigInt(keys.sequence);
  for (let index = nonce.length - 1; index >= 0 && sequence > 0n; index--) {
    nonce[index] ^= Number(sequence & 0xffn);
    sequence >>= 8n;
  }
  return nonce;
}

/** The 5-byte record header used as AEAD associated data. */
export function recordHeader(ciphertextLength: number): Buffer {
  return Buffer.from([
    0x17,
    0x03,
    0x03,
    (ciphertextLength >> 8) & 0xff,
    ciphertextLength & 0xff,
  ]);
}

export function sealRecord(
  suite: CipherSuite,
  keys: TrafficKeys,
  innerType: number,
  plaintext: Buffer,
): Buffer {
  const data = Buffer.concat([plaintext, Buffer.from([innerType])]);
  const header = recordHeader(data.length + 16);
  const cipher = crypto.createCipheriv(
    suite.algorithm,
    keys.key,
    nonceFor(keys),
  ) as CipherGCM;
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  keys.sequence += 1;
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

export function openRecord(
  suite: CipherSuite,
  keys: TrafficKeys,
  record: Buffer,
): { innerType: number; data: Buffer } {
  const body = record.subarray(5);
  const ciphertext = body.subarray(0, body.length - 16);
  const tag = body.subarray(body.length - 16);
  const decipher = crypto.createDecipheriv(
    suite.algorithm,
    keys.key,
    nonceFor(keys),
  ) as DecipherGCM;
  decipher.setAAD(record.subarray(0, 5));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  keys.sequence += 1;
  let end = plaintext.length - 1;
  while (end >= 0 && plaintext[end] === 0) end--;
  return { innerType: plaintext[end], data: plaintext.subarray(0, end) };
}
