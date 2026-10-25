// Local Bun relay for OpenCode Zen's anonymous free tier.
//
// Zen's free-tier gate now keys on the TLS ClientHello: it answers
// `429 {"type":"error","error":{"type":"FreeUsageLimitError",...}}` to every
// client whose handshake is not the OpenCode CLI's own Bun-fetch handshake,
// whatever the HTTP request says. Verified live: an exact byte replay of a
// captured CLI request (same headers, body, session ids, egress IP) fails over
// Node's TLS and over curl, and even Bun's own `node:https` path is refused,
// while `fetch` in the same Bun runtime is accepted.
//
// Node cannot emit that ClientHello: OpenSSL fixes the TLS 1.3 cipher order and
// the extension list, and BoringSSL's (Chrome's) order is what Zen accepts. So
// anonymous free-tier attempts are relayed through a tiny Bun process that
// performs the request with `fetch` and mirrors the response back over
// loopback. Everything else keeps the plain Node path unchanged.
//
// The relay is loopback-only, authenticated with a per-process bearer token,
// spawned lazily on the first relayed request, and killed with the gateway.
// Set OPENCODE_ZEN_RELAY=off to disable it (requests then go direct and Zen
// refuses them), or BUN_PATH to point at a specific bun binary.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "../logger";

export interface ZenRelay {
  /** Loopback endpoint; POST here with an `x-relay-target` header. */
  url: string;
  /** Bearer the relay demands on every request. */
  token: string;
}

export const ZEN_RELAY_TARGET_HEADER = "x-relay-target";
export const ZEN_RELAY_TOKEN_HEADER = "x-relay-token";
export const ZEN_RELAY_INSECURE_HEADER = "x-relay-insecure";
/**
 * Outbound proxy for the relayed hop (`http`, `https`, `socks5` with inline
 * credentials). The relay dials the real host, so a provider's proxy has to
 * travel with the request instead of through a Node agent. Bun applies it to
 * its own fetch, which keeps the accepted ClientHello while changing the
 * egress address.
 */
export const ZEN_RELAY_PROXY_HEADER = "x-relay-proxy";

// The child. Plain JavaScript on purpose: `tsc` does not need to see it, and
// Bun executes the file as-is. It mirrors status/headers/body 1:1 so the
// engine's own SSE parsing, usage accounting and transforms run untouched.
const RELAY_SCRIPT = `const token = process.env.RELAY_TOKEN ?? "";
if (!token) {
  console.error("relay: RELAY_TOKEN is required");
  process.exit(1);
}
const STRIPPED_REQUEST = new Set(["host", "content-length", "connection", "transfer-encoding"]);
const STRIPPED_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/relay") return new Response("not found", { status: 404 });
    if (req.headers.get("x-relay-token") !== token) return new Response("forbidden", { status: 403 });
    const target = req.headers.get("x-relay-target");
    if (!target) return new Response("missing x-relay-target", { status: 400 });
    const headers = {};
    for (const [name, value] of req.headers) {
      if (name.startsWith("x-relay-") || STRIPPED_REQUEST.has(name)) continue;
      headers[name] = value;
    }
    const insecure = req.headers.get("x-relay-insecure") === "1";
    const proxy = req.headers.get("x-relay-proxy") ?? undefined;
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
        signal: req.signal,
        ...(insecure ? { tls: { rejectUnauthorized: false } } : {}),
        ...(proxy ? { proxy } : {}),
      });
      const out = new Headers();
      upstream.headers.forEach((value, name) => {
        if (!STRIPPED_RESPONSE.has(name)) out.set(name, value);
      });
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (error) {
      return Response.json(
        { type: "error", error: { type: "ZenRelayError", message: String(error) } },
        { status: 502 },
      );
    }
  },
});
console.log("relay listening on " + server.port);
`;

const SCRIPT_NAME = "llm-gateway-zen-relay-v2.mjs";
const READY_RE = /relay listening on (\d+)/;
const START_TIMEOUT_MS = 15_000;

let scriptPath: string | null = null;
let child: ChildProcess | null = null;
let starting: Promise<ZenRelay | null> | null = null;
let warned = false;

export function zenRelayEnabled(): boolean {
  const flag = (process.env.OPENCODE_ZEN_RELAY ?? "").trim().toLowerCase();
  return flag !== "off" && flag !== "0" && flag !== "false";
}

function relayScriptPath(): string {
  if (scriptPath) return scriptPath;
  const file = path.join(os.tmpdir(), SCRIPT_NAME);
  writeFileSync(file, RELAY_SCRIPT, "utf8");
  scriptPath = file;
  return file;
}

function stopChild(): void {
  if (!child) return;
  const running = child;
  child = null;
  try {
    running.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

// Start (or reuse) the relay. Resolves null - once, with a warning - when Bun
// is missing or refuses to start; callers then keep the direct path instead of
// failing the request here.
export function ensureZenRelay(logger: Logger): Promise<ZenRelay | null> {
  if (!zenRelayEnabled()) return Promise.resolve(null);
  if (starting) return starting;
  if (child && !child.killed) {
    const ready = (child as ChildProcess & { zenRelay?: ZenRelay }).zenRelay;
    if (ready) return Promise.resolve(ready);
  }
  const token = randomBytes(24).toString("hex");
  const run = new Promise<ZenRelay | null>((resolve) => {
    const handle = { settled: false };
    const settle = (value: ZenRelay | null) => {
      if (handle.settled) return;
      handle.settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const spawnFailed = (reason: string) => {
      if (!warned) {
        warned = true;
        logger.warn("opencode_zen_relay_unavailable", {
          err: reason,
          hint: "anonymous Zen free-tier requests need Bun (OPENCODE_ZEN_RELAY=off disables the relay)",
        });
      }
      settle(null);
    };
    let proc: ChildProcess;
    try {
      const bun = (process.env.BUN_PATH ?? "").trim() || "bun";
      proc = spawn(bun, [relayScriptPath()], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RELAY_TOKEN: token },
      });
    } catch (err) {
      spawnFailed((err as Error).message);
      return;
    }
    const timer = setTimeout(
      () => spawnFailed("relay did not report a port in time"),
      START_TIMEOUT_MS,
    );
    if (typeof (timer as { unref?: () => void }).unref === "function")
      (timer as { unref: () => void }).unref();
    child = proc;
    let out = "";
    let errOut = "";
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const match = READY_RE.exec(out);
      if (!match) return;
      const relay: ZenRelay = {
        url: `http://127.0.0.1:${match[1]}/relay`,
        token,
      };
      (proc as ChildProcess & { zenRelay?: ZenRelay }).zenRelay = relay;
      settle(relay);
    });
    proc.stderr?.on("data", (chunk: string) => {
      errOut = `${errOut}${chunk}`.slice(-2000);
    });
    proc.on("error", (err: Error) => spawnFailed(err.message));
    proc.on("exit", (code, signal) => {
      if (child === proc) child = null;
      starting = null;
      spawnFailed(
        `relay exited (${signal ?? code}): ${errOut.trim() || out.trim()}`,
      );
    });
    // Never keep the gateway alive for the relay, and stop it with us.
    proc.unref();
  }).then((value) => {
    if (!value) starting = null;
    return value;
  });
  starting = run;
  return run;
}

// Test hook: forget the child so the next ensureZenRelay() starts fresh.
export function resetZenRelay(): void {
  stopChild();
  starting = null;
  warned = false;
}

process.once("exit", stopChild);
