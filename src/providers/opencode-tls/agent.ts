// `https.Agent` that speaks the Zen ClientHello.
//
// Node's own TLS cannot produce the handshake the free tier accepts, so this
// agent dials the endpoint (directly, or through the provider's proxy with a
// plain CONNECT/SOCKS tunnel), runs ./connection.ts over that socket, and hands
// the resulting duplex back to `https.request` - which then speaks HTTP/1.1
// exactly as it would over any other TLS socket.

import net from "node:net";
import type { Duplex } from "node:stream";
import { EventEmitter } from "node:events";
import {
  Agent as HttpsAgent,
  type AgentOptions,
  type RequestOptions,
} from "node:https";
import { agentFor } from "../../gateway/proxy-agent";
import { connectZenTls, type ZenTlsSocket } from "./connection";
import { verifyServerChain } from "./chain";
import type { Logger } from "../../logger";

export interface ZenTlsAgentOptions {
  /** Provider proxy URL; http(s) and socks are both tunneled in the clear. */
  proxy?: string | null;
  /** Extra trust anchors for chain validation (tests / private CAs). */
  ca?: string[];
  rejectUnauthorized?: boolean;
  /** TCP connect + TLS handshake deadline per socket. */
  timeoutMs?: number;
  logger?: Logger;
}

/** Bound the agent cache; each entry is one (proxy, CA, mode) combination. */
const MAX_AGENTS = 16;
const agents = new Map<string, ZenTlsAgent>();

/** One agent per (proxy, CA bundle, verification mode); sockets are not pooled. */
export function zenTlsAgent(options: ZenTlsAgentOptions = {}): ZenTlsAgent {
  const key = [
    options.proxy ?? "",
    (options.ca ?? []).join("\u0000"),
    options.rejectUnauthorized === false ? "insecure" : "verify",
    options.timeoutMs ?? "",
  ].join("|");
  const existing = agents.get(key);
  if (existing) return existing;
  const created = new ZenTlsAgent(options);
  agents.set(key, created);
  if (agents.size > MAX_AGENTS) {
    const [oldestKey, oldest] = agents.entries().next().value!;
    agents.delete(oldestKey);
    oldest.destroy();
  }
  return created;
}

/** Test hook. */
export function resetZenTlsAgents(): void {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

export class ZenTlsAgent extends HttpsAgent {
  private readonly zenOptions: ZenTlsAgentOptions;

  constructor(options: ZenTlsAgentOptions = {}) {
    // No pooling: every connection carries its own fresh ClientHello, and
    // keep-alive across requests would reuse one connection's keys forever.
    const agentOptions: AgentOptions = { keepAlive: false, maxSockets: 64 };
    super(agentOptions);
    this.zenOptions = options;
  }

  override createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): undefined {
    const host = String(options.host ?? "");
    const port = Number(options.port ?? 443);
    const servername = String(options.servername || host);
    // Per-request TLS settings come from the engine; ignoring them would let a
    // caller believe it disabled (or enabled) verification it did not.
    const perRequest = options as RequestOptions & {
      ca?: string | string[];
      rejectUnauthorized?: boolean;
      timeout?: number;
    };
    const ca =
      perRequest.ca === undefined
        ? this.zenOptions.ca
        : ([] as string[]).concat(perRequest.ca);
    const rejectUnauthorized =
      perRequest.rejectUnauthorized ?? this.zenOptions.rejectUnauthorized;
    const timeoutMs = perRequest.timeout ?? this.zenOptions.timeoutMs;
    void this.open({
      host,
      port,
      servername,
      ca,
      rejectUnauthorized,
      timeoutMs,
    }).then(
      (socket) => callback?.(null, socket),
      (err: Error) => {
        this.zenOptions.logger?.warn("zen_tls_connect_failed", {
          host,
          error: err.message,
          stack: err.stack,
        });
        callback?.(err, undefined as unknown as Duplex);
      },
    );
    return undefined;
  }

  private async open(target: {
    host: string;
    port: number;
    servername: string;
    ca?: string[];
    rejectUnauthorized?: boolean;
    timeoutMs?: number;
  }): Promise<ZenTlsSocket> {
    const timeoutMs = target.timeoutMs ?? 30_000;
    const socket = await tunnel(
      this.zenOptions.proxy,
      target.host,
      target.port,
      timeoutMs,
    );
    return connectZenTls({
      socket,
      servername: target.servername,
      timeoutMs,
      verifyChain: (chain) =>
        verifyServerChain(chain, {
          servername: target.servername,
          ca: target.ca,
          rejectUnauthorized: target.rejectUnauthorized,
        }),
    });
  }
}

/**
 * Plain TCP connection to `host:port`, through the provider's proxy when one is
 * configured. The proxy agents can hand back their unencrypted tunnel
 * (`secureEndpoint: false`), which is what the Zen handshake needs: TLS is
 * terminated by us, not by the agent.
 */
async function tunnel(
  proxy: string | null | undefined,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const agent = agentFor(proxy, true) as unknown as
    | {
        connect?: (req: unknown, opts: unknown) => Promise<net.Socket>;
      }
    | undefined;
  const socket = agent?.connect
    ? await withDeadline(
        // The proxy agents take a request-like object for abort signalling only.
        agent.connect(new EventEmitter(), {
          host,
          port,
          secureEndpoint: false,
        }),
        timeoutMs,
        () => new Error("tls: proxy tunnel timed out"),
      )
    : await withDeadline(
        new Promise<net.Socket>((resolve, reject) => {
          const raw = net.connect({ host, port });
          raw.once("connect", () => resolve(raw));
          raw.once("error", reject);
        }),
        timeoutMs,
        () => new Error("tls: tcp connect timed out"),
      );
  socket.setNoDelay(true);
  return socket;
}

/** Settle `promise`, destroying a socket that arrives after the deadline. */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  error: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
