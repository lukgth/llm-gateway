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

// Which address family outbound connections should use. "4" (the default) drops
// IPv6 whenever IPv4 exists; "6" does the inverse; "auto" restores Node's stock
// behavior. Read once at import — this reflects a machine-level network fact,
// not per-request state.
const FAMILY_PREF = (process.env.GATEWAY_DNS_FAMILY ?? "4").trim();

// A dns.lookup drop-in that RESOLVES ONLY THE PREFERRED FAMILY when that family
// has any addresses, falling back to the full list when it has none.
//
// Motivation: a host publishing AAAA records is unreachable over v6 from a box
// that HAS a v6 address but no working v6 route — common when an ISP hands out
// an address with broken transit, or when the AAAA is only routable inside its
// own region. The OS resolver can't know the route is dead, so it keeps handing
// back the AAAA and Node keeps trying it.
//
// Why FILTER rather than merely sort v4 first: with a MIXED list, Node's
// `autoSelectFamily` (Happy Eyeballs, on by default from Node 20) splits by
// family and alternates. Measured against a host with a reachable v4 (~330ms)
// and an unreachable v6, a mixed list ordered V4-FIRST fails with an
// empty-message ETIMEDOUT in ~520ms: Node hits its 250ms per-attempt timeout on
// the v4 that was about to succeed, switches to the v6, takes an instant
// ENETUNREACH, and collapses the aggregate into a timeout. The SAME list
// ordered v6-first succeeds, as does either ordering once the list is v4-only.
// So sorting v4 first doesn't just fail to help — it produces the exact
// ordering that triggers the bug. The unreachable family has to be absent.
//
// Multiple addresses WITHIN the chosen family are all returned, so Happy
// Eyeballs still races them and one dead IP in that family stays survivable.
// A v6-only host still resolves (there is no v4 to prefer). A dual-stack host
// whose V4 is the broken side is the case this deliberately trades away — set
// GATEWAY_DNS_FAMILY=6 for that, or =auto for Node's stock behavior.
export function ipv4FirstLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | LookupCb,
  callback?: LookupCb,
): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCb;
  const opts = (typeof options === "function" ? {} : (options ?? {})) as
    dns.LookupOneOptions | dns.LookupAllOptions;

  // An explicitly pinned family, or an opt-out, is the caller's decision.
  if (opts.family === 4 || opts.family === 6 || FAMILY_PREF === "auto") {
    dns.lookup(hostname, opts as dns.LookupOneOptions, cb as never);
    return;
  }

  const preferred = FAMILY_PREF === "6" ? 6 : 4;

  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length)
      return cb(
        Object.assign(new Error(`no address found for ${hostname}`), {
          code: "ENOTFOUND",
        }),
      );
    const wanted = list.filter((a) => a.family === preferred);
    // Fall back to the whole list when the preferred family isn't present at
    // all — a v6-only host must still resolve.
    const chosen = wanted.length ? wanted : list;
    // `all` is what Node passes when autoSelectFamily is on; it wants the whole
    // list. Otherwise it wants just the winner.
    if ((opts as dns.LookupAllOptions).all) return cb(null, chosen);
    cb(null, chosen[0].address, chosen[0].family);
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
    // NOTE: autoSelectFamilyAttemptTimeout is deliberately left at Node's
    // 250ms default. It looks like a knob worth raising for distant hosts
    // (their TCP connect exceeds 250ms), but the timer does not ABANDON the
    // slow socket — it starts a second one racing alongside it, and whichever
    // completes first wins. Measured on a v4-only list whose first address is
    // blackholed: 250ms recovers in 266ms, 5s takes 5007ms. Raising it only
    // slows failover to a dead address. The family-mixing hazard it appears to
    // address is handled by the lookup filter above instead.
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
