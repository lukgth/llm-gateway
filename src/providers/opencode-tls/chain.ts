// Certificate-chain validation for the hand-rolled TLS 1.3 client.
//
// The handshake proves the peer holds the leaf's private key (CertificateVerify
// in ./connection.ts); this module proves that leaf is trusted for the host.
// Both checks are required - possession alone accepts any self-signed cert.
//
// Node cannot validate the chain for us because `tls.connect` cannot produce
// the ClientHello the gate accepts, so the path is checked here against the
// trust store Node itself ships (`tls.rootCertificates`) plus any private CA.

import crypto from "node:crypto";
import tls from "node:tls";

const anchorCache = new Map<string, crypto.X509Certificate[]>();

function trustAnchors(ca: string[] | undefined): crypto.X509Certificate[] {
  const extra = ca ?? [];
  const key = extra.join("\u0000");
  const cached = anchorCache.get(key);
  if (cached) return cached;
  const pem = [...tls.rootCertificates, ...extra];
  const anchors: crypto.X509Certificate[] = [];
  for (const entry of pem) {
    try {
      anchors.push(new crypto.X509Certificate(entry));
    } catch {
      // A bundle can carry junk; a bad anchor only means it is not trusted.
    }
  }
  anchorCache.set(key, anchors);
  return anchors;
}

function spki(certificate: crypto.X509Certificate): string {
  return certificate.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

export interface ChainVerificationOptions {
  /** Hostname the connection was opened for (SNI). */
  servername: string;
  /** Extra PEM trust anchors (private CAs, tests). */
  ca?: string[];
  /** Skip every check. Only for providers explicitly configured that way. */
  rejectUnauthorized?: boolean;
}

/**
 * Throws unless the DER chain links leaf -> ... -> a trust anchor, the leaf is
 * valid for `servername`, and every certificate is inside its validity window.
 */
export function verifyServerChain(
  chain: Buffer[],
  options: ChainVerificationOptions,
): void {
  if (options.rejectUnauthorized === false) return;
  if (chain.length === 0) throw new Error("tls: server sent no certificate");

  let certificates: crypto.X509Certificate[];
  try {
    certificates = chain.map((der) => new crypto.X509Certificate(der));
  } catch {
    throw new Error("tls: server sent a malformed certificate");
  }

  const leaf = certificates[0];
  if (!leaf.checkHost(options.servername, { subject: "default" })) {
    throw new Error(`tls: certificate is not valid for ${options.servername}`);
  }

  const now = Date.now();
  for (const certificate of certificates) {
    if (Date.parse(certificate.validFrom) > now) {
      throw new Error("tls: certificate is not yet valid");
    }
    if (Date.parse(certificate.validTo) < now) {
      throw new Error("tls: certificate has expired");
    }
  }

  for (let index = 0; index + 1 < certificates.length; index++) {
    const certificate = certificates[index];
    const issuer = certificates[index + 1];
    if (
      !certificate.checkIssued(issuer) ||
      !certificate.verify(issuer.publicKey)
    ) {
      throw new Error("tls: certificate chain is not signed by its issuer");
    }
  }

  const last = certificates[certificates.length - 1];
  const anchors = trustAnchors(options.ca);
  if (anchors.some((anchor) => last.raw.equals(anchor.raw))) return;
  // A cross-signed root carries the trusted root's key under a foreign issuer
  // (Cloudflare serves GTS Root R4 signed by GlobalSign). The key is what the
  // trust store vouches for, so a matching SPKI anchors the chain.
  const lastKey = spki(last);
  const crossSigned = anchors.some((anchor) => spki(anchor) === lastKey);
  const anchored =
    crossSigned ||
    anchors.some(
      (anchor) => last.checkIssued(anchor) && last.verify(anchor.publicKey),
    );
  if (!anchored) {
    throw new Error(
      "tls: certificate chain does not end at a trusted certificate authority",
    );
  }
}
