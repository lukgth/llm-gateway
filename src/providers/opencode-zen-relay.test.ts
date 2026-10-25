// Loopback Bun relay: lifecycle + mirroring. The relay exists because Zen's
// free tier keys on the TLS ClientHello (see opencode-zen-relay.ts); these tests cover
// the plumbing that must not break - start/stop, header filtering, and a
// streamed body arriving intact - without touching the network: the "upstream"
// is a local HTTP server on 127.0.0.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import {
  ensureZenRelay,
  resetZenRelay,
  zenRelayEnabled,
  ZEN_RELAY_PROXY_HEADER,
  ZEN_RELAY_TARGET_HEADER,
  ZEN_RELAY_TOKEN_HEADER,
} from "./opencode-zen-relay";
import type { Logger } from "../logger";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

function bunAvailable(): boolean {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the relay honors its kill switch", () => {
  assert.equal(withEnv({ OPENCODE_ZEN_RELAY: "off" }, zenRelayEnabled), false);
  assert.equal(withEnv({ OPENCODE_ZEN_RELAY: "0" }, zenRelayEnabled), false);
  assert.equal(
    withEnv({ OPENCODE_ZEN_RELAY: undefined }, zenRelayEnabled),
    true,
  );
});

test("a missing bun degrades to null instead of throwing", async () => {
  resetZenRelay();
  const relay = await withEnv({ BUN_PATH: "/nonexistent/bun-for-test" }, () =>
    ensureZenRelay(logger),
  ).catch(() => null);
  assert.equal(relay, null);
  resetZenRelay();
});

test("a relayed request mirrors status, headers and a streamed body", async (t) => {
  if (!bunAvailable()) return t.skip("bun is not installed");

  // Upstream stand-in: records what the relay sent and answers with an SSE
  // body that must reach the client chunk-for-chunk.
  const seen: {
    method?: string;
    url?: string;
    headers?: http.IncomingHttpHeaders;
    body?: string;
  } = {};
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = body;
      res.writeHead(201, {
        "content-type": "text/event-stream",
        "x-upstream-marker": "kept",
        connection: "keep-alive",
      });
      res.write('data: {"n":1}\n\n');
      res.write('data: {"n":2}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(() => upstream.close());
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  resetZenRelay();
  const relay = await ensureZenRelay(logger);
  assert.ok(relay, "the relay must start when bun is installed");
  t.after(() => resetZenRelay());

  const body = JSON.stringify({ hello: "world" });
  const response = await new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    text: string;
  }>((resolve, reject) => {
    const req = http.request(
      relay.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          [ZEN_RELAY_TARGET_HEADER]: `http://127.0.0.1:${port}/v1/chat/completions`,
          [ZEN_RELAY_TOKEN_HEADER]: relay.token,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.body, body);
  // Control headers never leak upstream.
  assert.equal(seen.headers?.[ZEN_RELAY_TOKEN_HEADER], undefined);
  assert.equal(seen.headers?.["x-relay-insecure"], undefined);
  assert.equal(seen.headers?.[ZEN_RELAY_PROXY_HEADER], undefined);

  assert.equal(response.status, 201);
  assert.equal(response.headers["x-upstream-marker"], "kept");
  assert.match(response.text, /data: \{"n":1\}/);
  assert.match(response.text, /data: \[DONE\]/);
});

test("a relayed hop applies the provider proxy to its own fetch", async (t) => {
  if (!bunAvailable()) return t.skip("bun is not installed");

  // The egress proxy is the point of the header: with a dead proxy the relay
  // must fail instead of quietly dialling the upstream address itself, which is
  // what a local stand-in proves (it would otherwise answer 201).
  let reached = false;
  const upstream = http.createServer((_req, res) => {
    reached = true;
    res.writeHead(201).end("{}");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(() => upstream.close());
  const address = upstream.address();
  const port = typeof address === "object" && address ? address.port : 0;

  resetZenRelay();
  const relay = await ensureZenRelay(logger);
  assert.ok(relay);
  t.after(() => resetZenRelay());

  const response = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const req = http.request(
        relay.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [ZEN_RELAY_TARGET_HEADER]: `http://127.0.0.1:${port}/v1/chat/completions`,
            [ZEN_RELAY_TOKEN_HEADER]: relay.token,
            [ZEN_RELAY_PROXY_HEADER]: "socks5://user:pass@127.0.0.1:1",
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    },
  );

  assert.equal(reached, false, "the relay must not bypass the proxy");
  assert.equal(response.status, 502);
  assert.match(response.text, /ZenRelayError/);
});

test("the relay rejects a request without its token", async (t) => {
  if (!bunAvailable()) return t.skip("bun is not installed");
  resetZenRelay();
  const relay = await ensureZenRelay(logger);
  assert.ok(relay);
  t.after(() => resetZenRelay());

  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      relay.url,
      {
        method: "POST",
        headers: {
          [ZEN_RELAY_TARGET_HEADER]: "http://127.0.0.1:1/nope",
          [ZEN_RELAY_TOKEN_HEADER]: "wrong",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(status, 403);
});
