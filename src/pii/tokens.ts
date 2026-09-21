// PII placeholder tokens + the response-side re-hydrator.
//
// A redacted request carries `[[PII_<ENTITY>_<n>]]` where the value used to be.
// The provider (and the model) sees only that; on the way back the gateway
// swaps the original text in.
//
// The re-hydrator is BYTE-level, not SSE-event-level. A token is pure ASCII and
// always sits inside a JSON string, so it appears literally in the byte stream
// and can be spliced without parsing - which makes one implementation cover all
// three client formats (chat / messages / responses) and every text field in
// them, including thinking and tool-call arguments.

import { PassThrough, Transform, type TransformCallback } from "stream";

export const PII_TOKEN_PREFIX = "[[PII_";
export const PII_TOKEN_SUFFIX = "]]";

const PREFIX_BYTES = Buffer.from(PII_TOKEN_PREFIX, "utf8");
const SUFFIX_BYTES = Buffer.from(PII_TOKEN_SUFFIX, "utf8");
// Cap on bytes held back while waiting for a token to complete, so a stream
// carrying a stray `[[PII_` with no terminator can't buffer without bound.
const MAX_HOLD_BYTES = 1024;

/** `[[PII_<ENTITY_TYPE>_<n>]]`, n starting at 1, per request. */
export function piiToken(entityType: string, n: number): string {
  const type = entityType.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `${PII_TOKEN_PREFIX}${type}_${n}${PII_TOKEN_SUFFIX}`;
}

/** JSON.stringify(s).slice(1, -1) - so a stored value can be spliced straight
 *  into a JSON document (every SSE data payload and every buffered JSON body
 *  is one). */
export function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

// Replaces every COMPLETE token found in `buf`. Returns the resolved prefix
// plus the bytes that must be held back because they may be the start of a
// not-yet-complete token (an unterminated marker, or a trailing partial).
function resolve(
  buf: Buffer,
  map: Map<string, string>,
): { out: Buffer; hold: Buffer } {
  const parts: Buffer[] = [];
  let cursor = 0;
  // Nothing is held back unless a marker is still arriving.
  let cut = buf.length;
  for (;;) {
    const start = buf.indexOf(PREFIX_BYTES, cursor);
    if (start === -1) break;
    const end = buf.indexOf(SUFFIX_BYTES, start + PREFIX_BYTES.length);
    if (end === -1) {
      // Unterminated marker: everything before it is final, the marker is not.
      parts.push(buf.subarray(cursor, start));
      cursor = start;
      cut = start;
      break;
    }
    const token = buf
      .subarray(start, end + SUFFIX_BYTES.length)
      .toString("utf8");
    const original = map.get(token);
    if (original === undefined) {
      // Not ours (a model echoing some other marker) → leave verbatim.
      parts.push(buf.subarray(cursor, end + SUFFIX_BYTES.length));
      cursor = end + SUFFIX_BYTES.length;
      continue;
    }
    parts.push(buf.subarray(cursor, start), Buffer.from(original, "utf8"));
    cursor = end + SUFFIX_BYTES.length;
  }
  // A trailing partial marker ("...[[PI") must be held too - otherwise a chunk
  // boundary landing inside the marker would leak half a token to the client.
  for (let k = Math.min(PREFIX_BYTES.length - 1, buf.length); k >= 1; k--) {
    if (buf.subarray(buf.length - k).equals(PREFIX_BYTES.subarray(0, k))) {
      cut = Math.min(cut, buf.length - k);
      break;
    }
  }
  parts.push(buf.subarray(cursor, cut));
  return { out: Buffer.concat(parts), hold: buf.subarray(cut) };
}

/** One-shot, complete tokens only: the (empty) hold-back is re-appended, so a
 *  complete buffer loses nothing. */
export function rehydrateBuffer(
  buf: Buffer,
  map: Map<string, string> | undefined,
): Buffer {
  if (!map || map.size === 0) return buf;
  const r = resolve(buf, map);
  return r.hold.length ? Buffer.concat([r.out, r.hold]) : r.out;
}

class RehydrateTransform extends Transform {
  private readonly tokens: Map<string, string>;
  private carry: Buffer = Buffer.alloc(0);

  constructor(map: Map<string, string>) {
    // Same watermark as SseEventTransform: don't accumulate downstream backpressure.
    super({ highWaterMark: 0 });
    this.tokens = map;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    const joined = this.carry.length
      ? Buffer.concat([this.carry, chunk])
      : chunk;
    const r = resolve(joined, this.tokens);
    // Resolved bytes come first in stream order; the carry is only ever a tail.
    if (r.out.length) this.push(r.out);
    this.carry = r.hold;
    // Bound the hold: a stray marker with no terminator must not grow forever.
    if (this.carry.length > MAX_HOLD_BYTES) {
      const keep = PREFIX_BYTES.length - 1;
      this.push(this.carry.subarray(0, this.carry.length - keep));
      this.carry = this.carry.subarray(this.carry.length - keep);
    }
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (this.carry.length) this.push(this.carry);
    this.carry = Buffer.alloc(0);
    cb();
  }
}

/** Node Transform for the streaming path; a pass-through when `map` is empty,
 *  so a hop with redaction enabled but no PII in the request costs nothing. */
export function rehydrateTransform(
  map: Map<string, string> | undefined,
): Transform {
  if (!map || map.size === 0) return new PassThrough({ highWaterMark: 0 });
  return new RehydrateTransform(map);
}
