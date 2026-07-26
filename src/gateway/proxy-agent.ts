// Outbound proxy agents. When a provider has a `proxy` URL set, upstream
// requests are dispatched through a SOCKS5 or HTTP(S) proxy instead of a direct
// connection. Agents are cached by (proxyUrl, https) so we don't rebuild one per
// request. When no proxy is set we return undefined so callers keep Node's
// default global agent (unchanged behavior).

import http from "http";
import https from "https";
import dns from "dns";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

type Agent = http.Agent | https.Agent;

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

// A dns.lookup drop-in that returns IPv4 addresses ahead of IPv6.
//
// Motivation: a host that publishes AAAA records is unreachable over v6 from a
// box that HAS a v6 address but no working v6 route — a common state (ISP hands
// out an address, transit is broken; or the AAAA is only routable inside its own
// region). The OS resolver doesn't know the route is dead: glibc's RFC 6724
// sorting puts the AAAA first, Node follows it, and the connection hangs until
// the timeout while curl on the same box succeeds.
//
// This does NOT disable IPv6 — v6 addresses are still returned, just last. Paired
// with `autoSelectFamily: true` on the agent, Node races them in the order given
// and keeps the first to connect, so a v4-only host, a v6-only host, and a
// dual-stack host with either family broken all still work. The only thing that
// changes is which family gets tried first.
export function ipv4FirstLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | LookupCb,
  callback?: LookupCb,
): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCb;
  const opts = (typeof options === "function" ? {} : (options ?? {})) as
    dns.LookupOneOptions | dns.LookupAllOptions;

  // An explicitly pinned family is the caller's decision — don't reorder it.
  if (opts.family === 4 || opts.family === 6) {
    dns.lookup(hostname, opts as dns.LookupOneOptions, cb as never);
    return;
  }

  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length)
      return cb(
        Object.assign(new Error(`no address found for ${hostname}`), {
          code: "ENOTFOUND",
        }),
      );
    const sorted = [
      ...list.filter((a) => a.family === 4),
      ...list.filter((a) => a.family !== 4),
    ];
    // `all` is what Node passes when autoSelectFamily is on; it wants the whole
    // ordered list. Otherwise it wants just the winner.
    if ((opts as dns.LookupAllOptions).all) return cb(null, sorted);
    cb(null, sorted[0].address, sorted[0].family);
  });
}

const cache = new Map<string, Agent>();

// Returns an agent for the given proxy URL, or undefined for a direct
// connection. `proxyUrl` accepts socks5://, socks5h://, socks4://, http:// and
// https:// schemes. Throws only on a malformed URL; callers treat a throw as a
// bad-config attempt (surfaced as a failed request, not a crash).
export function agentFor(
  proxyUrl: string | null | undefined,
  isHttps: boolean,
): Agent | undefined {
  const url = (proxyUrl ?? "").trim();
  if (!url) return undefined;
  const cacheKey = `${isHttps ? "s" : "p"}:${url}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  let agent: Agent;
  if (scheme.startsWith("socks")) {
    agent = new SocksProxyAgent(url);
  } else if (scheme === "http" || scheme === "https") {
    // HttpsProxyAgent tunnels HTTPS via CONNECT and also proxies plain HTTP.
    agent = new HttpsProxyAgent(url);
  } else {
    throw new Error(`unsupported proxy scheme: ${scheme}`);
  }
  cache.set(cacheKey, agent);
  return agent;
}

const directCache = new Map<string, Agent>();

// An agent for a DIRECT (unproxied) connection: IPv4-first name resolution plus
// Happy Eyeballs.
//
// Both settings must live ON THE AGENT. `autoSelectFamily` and `lookup` are
// net.connect options, and http/https only forward them to the socket from the
// agent — passing them inline in the per-request options object is silently
// dropped (verified against tls.connect: inline never arrives, agent-level
// does). `autoSelectFamily`'s runtime default is also version-dependent (false
// on Node 18, which engines >=18 still allows; true from Node 20), so it's
// pinned rather than inherited.
//
// Callers that already have a proxy agent don't need this — the proxy resolves
// names at the far end, so address-family selection isn't ours to make.
export function directAgent(isHttps: boolean): Agent {
  const key = isHttps ? "s" : "p";
  const hit = directCache.get(key);
  if (hit) return hit;
  const opts = {
    autoSelectFamily: true,
    lookup: ipv4FirstLookup as unknown as undefined,
  };
  const agent = isHttps ? new https.Agent(opts) : new http.Agent(opts);
  directCache.set(key, agent);
  return agent;
}

// The agent every outbound call should use: the provider's proxy when one is
// configured, otherwise the IPv4-first direct agent. Prefer this over calling
// agentFor() and leaving `agent` undefined on a direct connection — that path
// silently falls back to Node's global agent, which does neither.
export function dispatchAgent(
  proxyUrl: string | null | undefined,
  isHttps: boolean,
): Agent {
  return agentFor(proxyUrl, isHttps) ?? directAgent(isHttps);
}

// True when a proxy string looks usable (has a scheme we support). Used by the
// admin layer to validate before saving without constructing an agent.
export function isSupportedProxy(proxyUrl: string): boolean {
  const s = proxyUrl.trim().toLowerCase();
  return (
    s.startsWith("socks") || s.startsWith("http://") || s.startsWith("https://")
  );
}
