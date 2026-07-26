#!/usr/bin/env node
// Diagnose "works in curl, fails in the gateway" for one provider host.
//
// Isolates the differences between curl and Node that actually bite:
//   - IPv6 vs IPv4 (curl does Happy Eyeballs; Node 18 does not by default)
//   - proxy env vars (curl honors http(s)_proxy; Node's http module does not)
//   - TLS/ALPN and path correctness
//
// Usage:
//   node scripts/diagnose-provider.js <url> [bearer-token]
//   node scripts/diagnose-provider.js https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models

const https = require("https");
const http = require("http");
const net = require("net");
const dns = require("dns");
const tls = require("tls");

const target = process.argv[2];
const token = process.argv[3] || "sk-test-invalid";
if (!target) {
  console.error("usage: node scripts/diagnose-provider.js <url> [bearer-token]");
  process.exit(1);
}
const url = new URL(target);
const isHttps = url.protocol === "https:";
const port = url.port || (isHttps ? 443 : 80);

const line = (k, v) => console.log(`  ${String(k).padEnd(30)} ${v}`);

async function main() {
  console.log(`\n=== target ===`);
  line("url", target);
  line("host", url.hostname);
  line("path", url.pathname + url.search);

  console.log(`\n=== runtime ===`);
  line("node", process.version);
  line("platform", `${process.platform} ${process.arch}`);
  const asf = net.getDefaultAutoSelectFamily
    ? net.getDefaultAutoSelectFamily()
    : "n/a";
  line("autoSelectFamily default", asf);
  if (asf === false)
    line("", "^ Node picks ONE address; a dead AAAA route hangs. curl would not.");

  console.log(`\n=== proxy env (curl honors these; node's http module does NOT) ===`);
  let anyProxy = false;
  for (const k of [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    if (process.env[k]) {
      anyProxy = true;
      line(k, process.env[k]);
    }
  }
  if (!anyProxy) line("(none set)", "");
  else
    console.log(
      "  ^ curl is using a proxy the gateway is NOT. Set the provider's `proxy`\n" +
        "    field to this value, or the two will never agree.",
    );

  console.log(`\n=== DNS ===`);
  for (const [label, fn] of [
    ["A   (IPv4)", dns.promises.resolve4],
    ["AAAA(IPv6)", dns.promises.resolve6],
  ]) {
    try {
      line(label, (await fn(url.hostname)).join(", "));
    } catch (e) {
      line(label, `none (${e.code})`);
    }
  }
  try {
    const ordered = await dns.promises.lookup(url.hostname, { all: true });
    line(
      "lookup order (what node uses)",
      ordered.map((a) => `${a.address}/v${a.family}`).join(", "),
    );
    if (ordered[0] && ordered[0].family === 6)
      line("", "^ node tries this FIRST. If v6 is blackholed here, it hangs.");
  } catch (e) {
    line("lookup", `failed: ${e.code}`);
  }

  console.log(`\n=== TCP connect per address family ===`);
  for (const family of [4, 6]) {
    await new Promise((done) => {
      const t = Date.now();
      const sock = net.connect({ host: url.hostname, port, family }, () => {
        line(`IPv${family}`, `connected in ${Date.now() - t}ms`);
        sock.destroy();
        done();
      });
      sock.setTimeout(8000, () => {
        line(`IPv${family}`, `TIMEOUT after ${Date.now() - t}ms  <-- suspect`);
        sock.destroy();
        done();
      });
      sock.on("error", (e) => {
        line(`IPv${family}`, `${e.code || e.message} (${Date.now() - t}ms)`);
        done();
      });
    });
  }

  if (isHttps) {
    console.log(`\n=== TLS ===`);
    await new Promise((done) => {
      const t = Date.now();
      const s = tls.connect(
        { host: url.hostname, port, servername: url.hostname, ALPNProtocols: ["h2", "http/1.1"] },
        () => {
          line("handshake", `${Date.now() - t}ms`);
          line("protocol", s.getProtocol());
          line("alpn", s.alpnProtocol || "(none)");
          const c = s.getPeerCertificate();
          line("cert CN", (c && c.subject && c.subject.CN) || "?");
          line("authorized", s.authorized ? "yes" : `no: ${s.authorizationError}`);
          s.destroy();
          done();
        },
      );
      s.setTimeout(10000, () => {
        line("handshake", `TIMEOUT after ${Date.now() - t}ms  <-- suspect`);
        s.destroy();
        done();
      });
      s.on("error", (e) => {
        line("handshake", `${e.code || e.message}`);
        done();
      });
    });
  }

  console.log(`\n=== HTTP GET (as the gateway sends it) ===`);
  const variants = [
    ["default", {}],
    ["autoSelectFamily:true", { autoSelectFamily: true }],
    ["forced IPv4", { family: 4 }],
    ["forced IPv6", { family: 6 }],
  ];
  for (const [name, extra] of variants) {
    await new Promise((done) => {
      const t = Date.now();
      const req = (isHttps ? https : http).request(
        {
          hostname: url.hostname,
          port,
          path: url.pathname + url.search,
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${token}` },
          ...extra,
        },
        (res) => {
          const c = [];
          res.on("data", (d) => c.push(d));
          res.on("end", () => {
            const body = Buffer.concat(c).toString("utf8").slice(0, 100).replace(/\s+/g, " ");
            line(name, `status=${res.statusCode} ${Date.now() - t}ms  ${body}`);
            done();
          });
          res.on("error", (e) => {
            line(name, `RESPONSE STREAM ERROR ${e.message || "(empty)"} ${Date.now() - t}ms`);
            done();
          });
        },
      );
      req.on("error", (e) => {
        line(name, `ERR ${e.message || "(empty message)"} code=${e.code || "?"} ${Date.now() - t}ms`);
        done();
      });
      req.setTimeout(15000, () => req.destroy(new Error("timeout after 15000ms")));
      req.end();
    });
  }

  console.log(`
=== how to read this ===
  401 everywhere            -> transport is fine; the key is the only problem.
  404                       -> wrong path. This provider's model list is at
                               {baseUrl}{basePath}{modelsPath}, e.g.
                               /compatible-mode/v1/models — NOT /v1/models.
  IPv6 timeout + IPv4 ok    -> dead AAAA route. The gateway now resolves IPv4
                               first on every direct connection, so this no
                               longer stalls it (v6 is kept as a fallback).
  a proxy var is set        -> curl uses it, the gateway does not. Copy it into
                               the provider's \`proxy\` field.
  TLS handshake timeout     -> filtered upstream; a proxy is required.
`);
}

main().catch((e) => {
  console.error("diagnostic failed:", e);
  process.exit(1);
});
