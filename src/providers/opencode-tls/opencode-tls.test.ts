// The Zen TLS client: ClientHello shape, and a real handshake + HTTP round trip
// against a local TLS 1.3 server (so the suite proves the record layer and the
// key schedule, not just the builder).

import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildClientHello, TEMPLATE } from "./client-hello";
import crypto from "node:crypto";
import { resetZenTlsAgents, zenTlsAgent } from "./agent";
import { verifyServerCertificateVerify } from "./connection";
import { verifyServerChain } from "./chain";

/** Self-signed leaf for 127.0.0.1/opencode.ai, generated once per test process. */
function makeCertificate(): { key: string; cert: string; ca: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=opencode.ai",
    "-addext",
    "subjectAltName=DNS:opencode.ai,DNS:localhost,IP:127.0.0.1",
  ]);
  return {
    key: fs.readFileSync(key, "utf8"),
    cert: fs.readFileSync(cert, "utf8"),
    ca: fs.readFileSync(cert, "utf8"),
  };
}

test("the built ClientHello keeps the captured shape", () => {
  const keyShare = Buffer.alloc(32, 7);
  const hello = buildClientHello({
    servername: "opencode.ai",
    random: Buffer.alloc(32, 1),
    sessionId: Buffer.alloc(32, 2),
    keyShare,
  });
  // Record header + 24-bit handshake length must both describe the buffer.
  assert.equal(hello.readUInt16BE(3), hello.length - 5);
  assert.equal(hello.readUIntBE(6, 3), hello.length - 9);
  assert.equal(hello[5], 0x01);
  assert.equal(hello.readUInt16BE(9), 0x0303);

  // Session id is the 32 bytes we passed.
  assert.equal(hello.readUInt8(43), 32);
  assert.deepEqual(hello.subarray(44, 76), Buffer.alloc(32, 2));

  const extensionsLength = hello.readUInt16BE(114);
  const end = 116 + extensionsLength;
  assert.equal(end, hello.length, "extension block must fill the hello");

  const types: number[] = [];
  let offset = 116;
  let keyShareData: Buffer | null = null;
  while (offset < end) {
    const type = hello.readUInt16BE(offset);
    const length = hello.readUInt16BE(offset + 2);
    types.push(type);
    if (type === 0x0033)
      keyShareData = hello.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  // SNI first, then the CLI's extension order; ALPN advertises only http/1.1.
  assert.deepEqual(
    types,
    [0, 0x17, 0xff01, 0xa, 0xb, 0x23, 0x10, 0x5, 0xd, 0x12, 0x33, 0x2d, 0x2b],
  );
  assert.ok(keyShareData);
  assert.equal(keyShareData.readUInt16BE(0), 36);
  assert.equal(keyShareData.readUInt16BE(2), 0x001d);
  assert.equal(keyShareData.readUInt16BE(4), 32);
  assert.deepEqual(keyShareData.subarray(6), keyShare);

  // The template itself still carries the CLI's 17 cipher suites.
  assert.equal(TEMPLATE.readUInt16BE(76), 34);
});

test("a handshake, an HTTP request and the response body all work", async (t) => {
  const material = makeCertificate();
  const seen: { path?: string; ua?: string; body?: string } = {};
  const server = https.createServer(
    {
      key: material.key,
      cert: material.cert,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    },
    (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        seen.path = req.url;
        seen.ua = req.headers["user-agent"] as string;
        seen.body = body;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pong");
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  resetZenTlsAgents();
  t.after(() => resetZenTlsAgents());
  const agent = zenTlsAgent({ ca: [material.ca] });

  const response = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const request = https.request(
        {
          host: "127.0.0.1",
          port,
          servername: "opencode.ai",
          path: "/inference/openai/v1/chat/completions",
          method: "POST",
          agent,
          headers: {
            "content-type": "application/json",
            "user-agent":
              "opencode/2.1.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ model: "big-pickle", ping: true }));
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.text, "pong");
  assert.equal(seen.path, "/inference/openai/v1/chat/completions");
  assert.match(seen.body ?? "", /big-pickle/);
});

test("an untrusted certificate is refused", async (t) => {
  const material = makeCertificate();
  const server = https.createServer(
    { key: material.key, cert: material.cert, minVersion: "TLSv1.3" },
    (_req, res) => res.writeHead(200).end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  resetZenTlsAgents();
  t.after(() => resetZenTlsAgents());
  // No `ca` bundle: the chain does not lead to a trust anchor, so the
  // handshake must fail even though the transport itself works.
  const agent = zenTlsAgent({});

  await assert.rejects(
    new Promise((resolve, reject) => {
      const request = https.request(
        { host: "127.0.0.1", port, servername: "opencode.ai", agent },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    }),
    /self-signed|unable to|not the one Node trusts|certificate/i,
  );
});

/** Wrap a CertificateVerify signature in the handshake message layout. */
function certificateVerify(scheme: number, signature: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 15;
  header.writeUIntBE(4 + signature.length, 1, 3);
  header.writeUInt16BE(scheme, 4);
  header.writeUInt16BE(signature.length, 6);
  return Buffer.concat([header, signature]);
}

test("CertificateVerify is checked over the RFC 8446 context, not the transcript", () => {
  const material = makeCertificate();
  const key = crypto.createPrivateKey(material.key);
  const der = new crypto.X509Certificate(material.cert).raw;
  const transcript = Buffer.from("transcript-through-certificate");
  const transcriptHash = crypto
    .createHash("sha256")
    .update(transcript)
    .digest();
  const context = Buffer.concat([
    Buffer.alloc(64, 0x20),
    Buffer.from("TLS 1.3, server CertificateVerify"),
    Buffer.alloc(1),
    transcriptHash,
  ]);

  const good = crypto.sign("sha256", context, key);
  verifyServerCertificateVerify({
    message: certificateVerify(0x0401, good),
    leafDer: der,
    transcriptThroughCertificate: transcript,
    handshakeHash: "sha256",
  });

  // Signing the bare transcript is the classic near-miss: same key, same
  // transcript, and it must not be accepted.
  const bare = crypto.sign("sha256", transcript, key);
  assert.throws(
    () =>
      verifyServerCertificateVerify({
        message: certificateVerify(0x0401, bare),
        leafDer: der,
        transcriptThroughCertificate: transcript,
        handshakeHash: "sha256",
      }),
    /CertificateVerify/,
  );

  const forged = Buffer.from(good);
  forged[forged.length - 1] ^= 0xff;
  assert.throws(
    () =>
      verifyServerCertificateVerify({
        message: certificateVerify(0x0401, forged),
        leafDer: der,
        transcriptThroughCertificate: transcript,
        handshakeHash: "sha256",
      }),
    /CertificateVerify/,
  );
});

test("chain validation requires a trust anchor and a matching host", () => {
  const material = makeCertificate();
  const der = new crypto.X509Certificate(material.cert).raw;

  verifyServerChain([der], { servername: "opencode.ai", ca: [material.ca] });
  assert.throws(
    () =>
      verifyServerChain([der], {
        servername: "example.com",
        ca: [material.ca],
      }),
    /not valid for example.com/,
  );
  assert.throws(
    () => verifyServerChain([der], { servername: "opencode.ai" }),
    /trusted certificate authority/,
  );
});
