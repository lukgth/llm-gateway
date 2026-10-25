// A TLS 1.3 client for OpenCode Zen's free tier, spoken over any connected
// socket (direct, or through the provider's proxy).
//
// Why this exists instead of `tls.connect`: the gate refuses every handshake
// that is not the CLI's (see ./client-hello.ts) and OpenSSL cannot be coerced
// into producing it. Everything below is therefore the real thing - Hello,
// key schedule, record layer, Certificate/CertificateVerify/Finished
// validation, certificate-chain and hostname checks against Node's trust store
// - just with the ClientHello bytes taken from a template.

import crypto from "node:crypto";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { buildClientHello, X25519 } from "./client-hello";
import {
  CIPHER_SUITES,
  deriveSecret,
  expandLabel,
  hash,
  hkdfExtract,
  openRecord,
  sealRecord,
  trafficKeys,
  type CipherSuite,
  type HashName,
  type TrafficKeys,
} from "./key-schedule";

const MAX_PLAINTEXT = 16 * 1024;
/** TLS 1.3 caps ciphertext at 2^14 + 256. */
const MAX_CIPHERTEXT = MAX_PLAINTEXT + 256;
/** Handshake messages larger than this are refused outright. */
const MAX_HANDSHAKE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ZenTlsOptions {
  /** Connected socket to the TLS endpoint. */
  socket: Socket;
  /** SNI and certificate hostname. */
  servername: string;
  /**
   * Chain validation: receives the DER chain the server presented (leaf first)
   * and must throw when it is not trusted for `servername`. Required - the
   * handshake itself only proves the peer holds the leaf's private key.
   */
  verifyChain: (chain: Buffer[]) => void | Promise<void>;
  /** Handshake deadline. */
  timeoutMs?: number;
}

/** Read exactly `size` bytes from a byte stream. */
class RecordReader {
  private buffer = Buffer.alloc(0);
  private pending: (() => void) | null = null;
  private closed: Error | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.pending?.();
  };
  private readonly onClose = (): void => {
    this.closed = new Error("tls: socket closed during handshake");
    this.pending?.();
  };
  private readonly onError = (err: Error): void => {
    this.closed = err;
    this.pending?.();
  };

  constructor(
    private readonly socket: Socket,
    private readonly onClosed: (err: Error) => void,
  ) {
    socket.on("data", this.onData);
    socket.on("close", this.onClose);
    socket.on("error", this.onError);
  }

  async chunk(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.closed) throw this.closed;
      await new Promise<void>((resolve) => {
        this.pending = resolve;
      });
      this.pending = null;
    }
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  async record(): Promise<Buffer> {
    const header = await this.chunk(5);
    const length = header.readUInt16BE(3);
    if (length > MAX_CIPHERTEXT)
      throw new Error(`tls: oversized record ${length}`);
    const body = length ? await this.chunk(length) : Buffer.alloc(0);
    return Buffer.concat([header, body]);
  }

  /** Bytes already read past the handshake. */
  take(): Buffer {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }

  detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("error", this.onError);
    this.onClosed(new Error("tls: reader detached"));
  }
}

/** Accumulates handshake messages, which may be split across records. */
class HandshakeBuffer {
  private buffer = Buffer.alloc(0);
  messages: Buffer[] = [];

  push(data: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > MAX_HANDSHAKE_BYTES)
      throw new Error("tls: oversized handshake message");
    const complete: Buffer[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUIntBE(1, 3);
      if (this.buffer.length < 4 + length) break;
      complete.push(this.buffer.subarray(0, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }
    this.messages.push(...complete);
    return complete;
  }
}

interface ParsedServerHello {
  suite: CipherSuite;
  serverKeyShare: Buffer;
}

function parseServerHello(
  message: Buffer,
  sessionId: Buffer,
): ParsedServerHello {
  if (message[0] !== 2)
    throw new Error("tls: server did not send a ServerHello");
  if (message.length < 4 + 2 + 32 + 1)
    throw new Error("tls: truncated ServerHello");
  if (message.readUInt16BE(4) !== 0x0303)
    throw new Error("tls: server is not speaking TLS 1.3");
  let offset = 4 + 2 + 32;
  const sessionIdLength = message[offset];
  if (sessionIdLength !== sessionId.length)
    throw new Error("tls: server did not echo the session id");
  if (
    !message
      .subarray(offset + 1, offset + 1 + sessionIdLength)
      .equals(sessionId)
  )
    throw new Error("tls: server did not echo the session id");
  offset += 1 + sessionIdLength;
  const suite = CIPHER_SUITES[message.readUInt16BE(offset)];
  offset += 2;
  if (message[offset] !== 0)
    throw new Error("tls: server chose a compression method");
  offset += 1;
  const extensionsLength = message.readUInt16BE(offset);
  offset += 2;
  const end = offset + extensionsLength;
  let keyShare: Buffer | null = null;
  let group = 0;
  while (offset < end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    if (type === 0x0033) {
      group = message.readUInt16BE(offset + 4);
      const keyLength = message.readUInt16BE(offset + 6);
      keyShare = message.subarray(offset + 8, offset + 8 + keyLength);
    }
    offset += 4 + length;
  }
  if (!suite) throw new Error("tls: server chose an unsupported cipher suite");
  if (end > message.length) throw new Error("tls: truncated ServerHello");
  if (!keyShare) throw new Error("tls: server sent no key share");
  if (group !== X25519) {
    throw new Error(`tls: server chose unsupported group ${group}`);
  }
  return { suite, serverKeyShare: keyShare };
}

/**
 * Parse the server's Certificate message into DER entries.
 *
 * Verification is deliberately *not* done here: this client cannot use
 * OpenSSL to check the CertificateVerify signature (the very reason it exists
 * is that OpenSSL cannot produce the accepted handshake), and re-implementing
 * chain building badly is worse than not doing it. `verifyChain` gets the DER
 * chain instead, and the agent validates it against Node's own TLS stack.
 */
function parseCertificateChain(message: Buffer): Buffer[] {
  // handshake header, certificate_request_context (empty from a server), then
  // the DER chain.
  const fail = (): never => {
    throw new Error("tls: malformed Certificate message");
  };
  if (message.length < 8) fail();
  let offset = 4;
  const contextLength = message[offset];
  offset += 1 + contextLength;
  if (offset + 3 > message.length) fail();
  const listLength = message.readUIntBE(offset, 3);
  offset += 3;
  if (offset + listLength !== message.length) fail();
  const end = offset + listLength;
  const chain: Buffer[] = [];
  while (offset < end) {
    // CertificateEntry: 3-byte cert_data length, the DER, then the entry's own
    // (empty) extensions vector - 2 bytes that are easy to forget.
    if (offset + 3 > end) fail();
    const certLength = message.readUIntBE(offset, 3);
    offset += 3;
    if (certLength === 0 || offset + certLength + 2 > end) fail();
    chain.push(Buffer.from(message.subarray(offset, offset + certLength)));
    offset += certLength;
    const extensionsLength = message.readUInt16BE(offset);
    offset += 2 + extensionsLength;
    if (offset > end) fail();
  }
  if (chain.length === 0) throw new Error("tls: server sent no certificate");
  return chain;
}

export class ZenTlsSocket extends Duplex {
  private raw: Buffer = Buffer.alloc(0);
  private tornDown = false;
  private peerClosed = false;
  private keyUpdates = 0;
  private readonly handshake = new HandshakeBuffer();

  constructor(
    private readonly socket: Socket,
    private readonly suite: CipherSuite,
    private readKeys: TrafficKeys,
    private writeKeys: TrafficKeys,
    private readSecret: Buffer,
    private writeSecret: Buffer,
    leftover: Buffer,
  ) {
    super();
    // An error raised before the consumer attaches a listener would otherwise
    // become an uncaught exception and take the process down.
    const swallow = (): void => {};
    this.on("error", swallow);
    this.once("newListener", (event) => {
      if (event === "error") this.off("error", swallow);
    });
    socket.on("data", (chunk: Buffer) => this.onRaw(chunk));
    socket.on("close", () => this.onSocketEnd());
    socket.on("error", (err: Error) => this.destroy(err));
    socket.on("end", () => this.onSocketEnd());
    socket.setNoDelay(true);
    // Decrypting here would emit before the caller has attached listeners.
    if (leftover.length) queueMicrotask(() => this.onRaw(leftover));
  }

  /**
   * TCP close without a `close_notify` is a truncation, not an end of stream:
   * treating it as EOF lets an on-path attacker shorten a response body.
   */
  private onSocketEnd(): void {
    if (this.tornDown) return;
    if (this.peerClosed) {
      this.finishClose();
      return;
    }
    this.destroy(new Error("tls: connection closed without close_notify"));
  }

  private onRaw(chunk: Buffer): void {
    if (this.tornDown) return;
    this.raw = Buffer.concat([this.raw, chunk]);
    while (this.raw.length >= 5) {
      const length = this.raw.readUInt16BE(3);
      if (length > MAX_CIPHERTEXT) {
        this.destroy(new Error(`tls: oversized record ${length}`));
        return;
      }
      if (this.raw.length < 5 + length) break;
      const record = this.raw.subarray(0, 5 + length);
      this.raw = this.raw.subarray(5 + length);
      if (record[0] === 0x14) continue; // compatibility CCS
      if (record[0] !== 0x17) {
        this.destroy(new Error(`tls: unexpected record type ${record[0]}`));
        return;
      }
      let opened: { innerType: number; data: Buffer };
      try {
        opened = openRecord(this.suite, this.readKeys, record);
      } catch (err) {
        this.destroy(err as Error);
        return;
      }
      if (opened.data.length > MAX_PLAINTEXT) {
        this.destroy(new Error("tls: oversized plaintext record"));
        return;
      }
      if (opened.innerType === 0x17) {
        if (!this.push(opened.data)) this.socket.pause();
      } else if (opened.innerType === 0x16) {
        try {
          this.onHandshake(opened.data);
        } catch (err) {
          this.destroy(err as Error);
          return;
        }
      } else if (opened.innerType === 0x15) {
        const level = opened.data[0];
        const description = opened.data[1];
        if (description === 0) {
          this.peerClosed = true;
          this.finishClose();
        } else {
          this.destroy(
            new Error(
              `tls: peer alert ${description}${level === 2 ? " (fatal)" : ""}`,
            ),
          );
        }
        return;
      } else {
        this.destroy(
          new Error(`tls: unexpected inner content type ${opened.innerType}`),
        );
        return;
      }
    }
  }

  private onHandshake(data: Buffer): void {
    for (const message of this.handshake.push(data)) {
      // Only KeyUpdate matters post-handshake; NewSessionTicket is dropped
      // because this client never resumes.
      if (message[0] !== 24) continue;
      if (message.length !== 5) throw new Error("tls: malformed KeyUpdate");
      if (++this.keyUpdates > 8) throw new Error("tls: too many KeyUpdates");
      const requested = message[4] === 1;
      this.readSecret = expandLabel(
        this.suite.hash,
        this.readSecret,
        "traffic upd",
        Buffer.alloc(0),
        this.suite.hash === "sha384" ? 48 : 32,
      );
      this.readKeys = trafficKeys(
        this.suite.hash,
        this.readSecret,
        this.suite.keyLength,
        this.suite.ivLength,
      );
      if (requested) {
        this.writeRaw(Buffer.from([24, 0, 0, 1, 0]), 0x16);
        this.writeSecret = expandLabel(
          this.suite.hash,
          this.writeSecret,
          "traffic upd",
          Buffer.alloc(0),
          this.suite.hash === "sha384" ? 48 : 32,
        );
        this.writeKeys = trafficKeys(
          this.suite.hash,
          this.writeSecret,
          this.suite.keyLength,
          this.suite.ivLength,
        );
      }
    }
  }

  /** Returns false when the socket asked us to wait for `drain`. */
  private writeRaw(plaintext: Buffer, innerType: number): boolean {
    if (this.tornDown) throw new Error("tls: connection is closed");
    let writable = true;
    for (
      let offset = 0;
      offset < plaintext.length || offset === 0;
      offset += MAX_PLAINTEXT
    ) {
      const slice = plaintext.subarray(offset, offset + MAX_PLAINTEXT);
      writable =
        this.socket.write(
          sealRecord(this.suite, this.writeKeys, innerType, slice),
        ) && writable;
      if (plaintext.length === 0) break;
    }
    return writable;
  }

  /** Wait for the raw socket to accept more bytes. */
  private drained(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onDrain = (): void => {
        this.socket.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        this.socket.off("drain", onDrain);
        reject(err);
      };
      this.socket.once("drain", onDrain);
      this.socket.once("error", onError);
    });
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (this.writeRaw(chunk, 0x17)) {
        callback();
        return;
      }
    } catch (err) {
      callback(err as Error);
      return;
    }
    // Backpressure: the raw socket is full, so keep the chunk in our queue.
    void this.drained().then(
      () => callback(),
      (err: Error) => callback(err),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      // close_notify is an alert record: level 1, description 0.
      this.writeRaw(Buffer.from([1, 0]), 0x15);
      this.socket.end();
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.tornDown = true;
    this.socket.destroy();
    callback(err);
  }

  private finishClose(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.push(null);
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    this.socket.setTimeout(milliseconds, callback);
    return this;
  }

  setNoDelay(noDelay = true): this {
    this.socket.setNoDelay(noDelay);
    return this;
  }

  setKeepAlive(enable = false, delay = 0): this {
    this.socket.setKeepAlive(enable, delay);
    return this;
  }
}

/**
 * Perform the handshake over `socket` and return a duplex that carries
 * application data. The socket is consumed on failure.
 */
export async function connectZenTls(
  options: ZenTlsOptions,
): Promise<ZenTlsSocket> {
  const { socket, servername } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let detach: (() => void) | null = null;
  const timer = setTimeout(() => {
    socket.destroy(new Error("tls: handshake timed out"));
  }, timeoutMs);
  timer.unref?.();

  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
    const keyShare = publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    const sessionId = crypto.randomBytes(32);
    const clientHello = buildClientHello({
      servername,
      random: crypto.randomBytes(32),
      sessionId,
      keyShare,
    });

    const reader = new RecordReader(socket, () => {});
    detach = () => reader.detach();
    socket.write(clientHello);

    let transcript = Buffer.from(clientHello.subarray(5));
    let leafDer: Buffer | null = null;
    let transcriptThroughCertificate: Buffer | null = null;
    let serverHello: Buffer | null = null;
    while (!serverHello) {
      const record = await reader.record();
      if (record[0] === 0x14) continue;
      if (record[0] === 0x15) {
        throw new Error(
          `tls: server refused the handshake (alert ${record[6] ?? 0})`,
        );
      }
      if (record[0] !== 0x16)
        throw new Error(`tls: unexpected record ${record[0]}`);
      const message = record.subarray(5);
      const retryMagic = message
        .subarray(6, 38)
        .equals(
          Buffer.from(
            "cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c",
            "hex",
          ),
        );
      if (retryMagic) throw new Error("tls: server sent HelloRetryRequest");
      serverHello = message;
      transcript = Buffer.concat([transcript, message]);
    }

    const parsed = parseServerHello(serverHello, sessionId);
    const suite = parsed.suite;
    // HKDF-Extract(0, 0) with Hash.length zeros - 48 bytes under SHA-384.
    const zeros = Buffer.alloc(suite.hash === "sha384" ? 48 : 32);
    const peerKey = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        parsed.serverKeyShare,
      ]),
      format: "der",
      type: "spki",
    });
    const shared = crypto.diffieHellman({ privateKey, publicKey: peerKey });

    const early = hkdfExtract(suite.hash, zeros, zeros);
    const derived = deriveSecret(
      suite.hash,
      early,
      "derived",
      hash(suite.hash, Buffer.alloc(0)),
    );
    const handshakeSecret = hkdfExtract(suite.hash, derived, shared);
    const clientHandshakeSecret = deriveSecret(
      suite.hash,
      handshakeSecret,
      "c hs traffic",
      hash(suite.hash, transcript),
    );
    const serverHandshakeSecret = deriveSecret(
      suite.hash,
      handshakeSecret,
      "s hs traffic",
      hash(suite.hash, transcript),
    );
    const readKeys = trafficKeys(
      suite.hash,
      serverHandshakeSecret,
      suite.keyLength,
      suite.ivLength,
    );
    const writeKeys = trafficKeys(
      suite.hash,
      clientHandshakeSecret,
      suite.keyLength,
      suite.ivLength,
    );

    // Server flight: EncryptedExtensions, Certificate, CertificateVerify,
    // Finished - all under the handshake keys.
    const handshake = new HandshakeBuffer();
    let serverFinishedVerified = false;
    let certificateVerified = false;
    let handshakeBytes = 0;
    while (!serverFinishedVerified) {
      const record = await reader.record();
      if (record[0] === 0x14) continue;
      if (record[0] === 0x15) {
        throw new Error(`tls: alert during handshake (${record[6] ?? 0})`);
      }
      if (record[0] !== 0x17)
        throw new Error(`tls: unexpected record ${record[0]}`);
      const opened = openRecord(suite, readKeys, record);
      if (opened.innerType !== 0x16) continue;
      handshakeBytes += opened.data.length;
      if (handshakeBytes > MAX_HANDSHAKE_BYTES)
        throw new Error("tls: oversized server flight");
      for (const message of handshake.push(opened.data)) {
        const type = message[0];
        if (type === 11) {
          const chainDer = parseCertificateChain(message);
          transcriptThroughCertificate = Buffer.concat([transcript, message]);
          if (options.verifyChain) await options.verifyChain(chainDer);
          leafDer = chainDer[0];
        } else if (type === 15) {
          if (!leafDer || !transcriptThroughCertificate) {
            throw new Error("tls: CertificateVerify before Certificate");
          }
          verifyServerCertificateVerify({
            message,
            leafDer,
            transcriptThroughCertificate,
            handshakeHash: suite.hash,
          });
          certificateVerified = true;
        }
        transcript = Buffer.concat([transcript, message]);
        if (type === 20) {
          if (!certificateVerified) {
            throw new Error("tls: server Finished before CertificateVerify");
          }
          const finishedKey = expandLabel(
            suite.hash,
            serverHandshakeSecret,
            "finished",
            Buffer.alloc(0),
            suite.hash === "sha384" ? 48 : 32,
          );
          const expected = crypto
            .createHmac(suite.hash, finishedKey)
            .update(
              hash(
                suite.hash,
                transcript.subarray(0, transcript.length - message.length),
              ),
            )
            .digest();
          if (!expected.equals(message.subarray(4))) {
            throw new Error("tls: server Finished does not verify");
          }
          serverFinishedVerified = true;
        }
      }
    }

    const clientFinishedKey = expandLabel(
      suite.hash,
      clientHandshakeSecret,
      "finished",
      Buffer.alloc(0),
      suite.hash === "sha384" ? 48 : 32,
    );
    const verifyData = crypto
      .createHmac(suite.hash, clientFinishedKey)
      .update(hash(suite.hash, transcript))
      .digest();
    const finishedMessage = Buffer.concat([
      Buffer.from([20]),
      Buffer.from([0, 0, verifyData.length]),
      verifyData,
    ]);

    const masterSecret = hkdfExtract(
      suite.hash,
      deriveSecret(
        suite.hash,
        handshakeSecret,
        "derived",
        hash(suite.hash, Buffer.alloc(0)),
      ),
      zeros,
    );
    const transcriptHash = hash(suite.hash, transcript);
    const clientAppSecret = deriveSecret(
      suite.hash,
      masterSecret,
      "c ap traffic",
      transcriptHash,
    );
    const serverAppSecret = deriveSecret(
      suite.hash,
      masterSecret,
      "s ap traffic",
      transcriptHash,
    );

    socket.write(sealRecord(suite, writeKeys, 0x16, finishedMessage));

    const leftover = reader.take();
    detach?.();
    socket.pause();
    return new ZenTlsSocket(
      socket,
      suite,
      trafficKeys(suite.hash, serverAppSecret, suite.keyLength, suite.ivLength),
      trafficKeys(suite.hash, clientAppSecret, suite.keyLength, suite.ivLength),
      serverAppSecret,
      clientAppSecret,
      leftover,
    );
  } catch (err) {
    detach?.();
    socket.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type { HashName };

const SIGNATURE_SCHEMES: Record<
  number,
  { hash: string | null; pss?: boolean }
> = {
  0x0401: { hash: "sha256" },
  0x0501: { hash: "sha384" },
  0x0601: { hash: "sha512" },
  0x0403: { hash: "sha256" },
  0x0503: { hash: "sha384" },
  0x0603: { hash: "sha512" },
  0x0804: { hash: "sha256", pss: true },
  0x0805: { hash: "sha384", pss: true },
  0x0806: { hash: "sha512", pss: true },
  0x0807: { hash: null },
  0x0808: { hash: null },
};

const SERVER_VERIFY_CONTEXT = Buffer.from("TLS 1.3, server CertificateVerify");

/**
 * RFC 8446 4.4.3: the signature covers 64 spaces, the role context string, a
 * separator and the transcript hash - not the transcript itself. Omitting the
 * context makes every signature look invalid.
 */
export function verifyServerCertificateVerify(input: {
  message: Buffer;
  leafDer: Buffer;
  transcriptThroughCertificate: Buffer;
  handshakeHash: "sha256" | "sha384";
}): void {
  const scheme = input.message.readUInt16BE(4);
  const signatureLength = input.message.readUInt16BE(6);
  if (input.message.length !== 8 + signatureLength) {
    throw new Error("tls: malformed CertificateVerify");
  }
  const signature = input.message.subarray(8);
  const parameters = SIGNATURE_SCHEMES[scheme];
  if (!parameters) {
    throw new Error(
      `tls: unsupported CertificateVerify scheme 0x${scheme.toString(16)}`,
    );
  }
  const leaf = new crypto.X509Certificate(input.leafDer);
  const content = Buffer.concat([
    Buffer.alloc(64, 0x20),
    SERVER_VERIFY_CONTEXT,
    Buffer.alloc(1),
    hash(input.handshakeHash, input.transcriptThroughCertificate),
  ]);
  const options: crypto.VerifyKeyObjectInput = parameters.pss
    ? {
        key: leaf.publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      }
    : { key: leaf.publicKey };
  let verified = false;
  try {
    verified = crypto.verify(parameters.hash, content, options, signature);
  } catch (error) {
    throw new Error(
      `tls: server CertificateVerify does not verify (${(error as Error).message})`,
    );
  }
  if (!verified)
    throw new Error("tls: server CertificateVerify does not verify");
}
