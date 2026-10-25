// OpenCode Zen free-tier ClientHello.
//
// The free tier only accepts the handshake the OpenCode CLI produces (Bun's
// `fetch`): the same cipher order, the same extension set and order, the same
// signature algorithms. Measured A/B through one proxy egress, identical HTTP
// bytes seconds apart: Bun -> 200, Node's own TLS -> 429 FreeUsageLimitError,
// even with ciphers, curves and sigalgs forced to match. OpenSSL's extension
// order and TLS 1.3 suite order are not configurable, so no `tls.connect`
// option can produce it - hence this template.
//
// The template is a captured ClientHello with three fields zeroed: the client
// random, the legacy session id and the hybrid key share. The builder re-fills
// them per connection. Everything else - cipher list, extension order, ALPN,
// signature algorithms - is byte-identical to the CLI's.
//
// The one deliberate deviation: the CLI offers X25519MLKEM768 first, and a
// client that offers it must also provide an MLKEM key share (the server
// answers HelloRetryRequest otherwise). Node cannot compute MLKEM, so the
// builder narrows `supported_groups` to X25519/P-256/P-384 and sends an X25519
// key share. Group *values* are not part of a JA3/JA4 fingerprint (only which
// extensions are present, and in what order), so the fingerprint is unchanged;
// verified live: this exact hello is answered 200 by the gate.

/** Captured CLI ClientHello, base64, with random/session-id/key-share zeroed. */
const TEMPLATE_BASE64 = `
FgMBBcUBAAXBAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAiEwETAhMDwCvAL8AswDDMqcyowAnAE8AKwBQAnACdAC8ANQEA
BVYAFwAA/wEAAQAACgAKAAgR7AAdABcAGAALAAIBAAAjAAAAEAALAAkIaHR0cC8xLjEABQAFAQAA
AAAADQAYABYEAwgEBAEFAwgFBQEIBgYBCAcGAwIBABIAAAAzBOoE6BHsBMAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAB0AIDrVb15yEMQGs+5RetdvJyuRwBzDbfDMO8Hnsc3w+nN6AC0AAgEBACsABQQDBAMD
`;

export const TEMPLATE = Buffer.from(
  TEMPLATE_BASE64.replace(/\s+/g, ""),
  "base64",
);

/** Offsets inside the template (record 5 + handshake 4 + legacy version 2). */
const OFFSET_RANDOM = 11;
const OFFSET_SESSION_ID_LENGTH = 43;
const OFFSET_SESSION_ID = 44;
const OFFSET_EXTENSIONS_LENGTH = 114;
const OFFSET_EXTENSIONS = 116;

/** Groups the builder advertises: X25519, P-256, P-384 (no MLKEM). */
export const X25519 = 0x001d;
const P256 = 0x0017;
const P384 = 0x0018;

export interface ClientHelloInput {
  servername: string;
  /** 32 random bytes. */
  random: Buffer;
  /** 32-byte legacy session id (middlebox compatibility). */
  sessionId: Buffer;
  /** 32-byte X25519 public key. */
  keyShare: Buffer;
}

/**
 * Build the ClientHello for one connection. Mirrors the CLI's hello byte for
 * byte outside the three per-connection fields and the narrowed group list.
 */
export function buildClientHello(input: ClientHelloInput): Buffer {
  const template = Buffer.from(TEMPLATE);
  input.random.copy(template, OFFSET_RANDOM);
  template.writeUInt8(input.sessionId.length, OFFSET_SESSION_ID_LENGTH);
  input.sessionId.copy(template, OFFSET_SESSION_ID);

  const extensionsEnd =
    OFFSET_EXTENSIONS + template.readUInt16BE(OFFSET_EXTENSIONS_LENGTH);
  const pieces: Buffer[] = [serverNameExtension(input.servername)];
  let offset = OFFSET_EXTENSIONS;
  while (offset < extensionsEnd) {
    const type = template.readUInt16BE(offset);
    const length = template.readUInt16BE(offset + 2);
    if (type === 0x000a) {
      pieces.push(extension(0x000a, groupListExtension()));
    } else if (type === 0x0033) {
      pieces.push(extension(0x0033, keyShareExtension(input.keyShare)));
    } else {
      pieces.push(template.subarray(offset, offset + 4 + length));
    }
    offset += 4 + length;
  }

  const extensions = Buffer.concat(pieces);
  const hello = Buffer.concat([
    template.subarray(0, OFFSET_EXTENSIONS_LENGTH),
    Buffer.from([extensions.length >> 8, extensions.length & 0xff]),
    extensions,
  ]);
  // Record length is 16-bit, the handshake length inside it is 24-bit.
  hello.writeUInt16BE(hello.length - 5, 3);
  hello.writeUIntBE(hello.length - 9, 6, 3);
  return hello;
}

function extension(type: number, body: Buffer): Buffer {
  const header = Buffer.from([
    type >> 8,
    type & 0xff,
    body.length >> 8,
    body.length & 0xff,
  ]);
  return Buffer.concat([header, body]);
}

function serverNameExtension(servername: string): Buffer {
  const name = Buffer.from(servername, "utf8");
  const body = Buffer.concat([
    Buffer.from([(name.length + 3) >> 8, (name.length + 3) & 0xff, 0x00]),
    Buffer.from([name.length >> 8, name.length & 0xff]),
    name,
  ]);
  return extension(0x0000, body);
}

function groupListExtension(): Buffer {
  const groups = [X25519, P256, P384];
  const body = Buffer.alloc(2 + groups.length * 2);
  body.writeUInt16BE(groups.length * 2, 0);
  groups.forEach((group, index) => body.writeUInt16BE(group, 2 + index * 2));
  return body;
}

function keyShareExtension(keyShare: Buffer): Buffer {
  const entry = Buffer.concat([
    Buffer.from([
      X25519 >> 8,
      X25519 & 0xff,
      keyShare.length >> 8,
      keyShare.length & 0xff,
    ]),
    keyShare,
  ]);
  return Buffer.concat([
    Buffer.from([entry.length >> 8, entry.length & 0xff]),
    entry,
  ]);
}
