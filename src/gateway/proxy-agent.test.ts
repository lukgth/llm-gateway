// IPv4-first name resolution for direct (unproxied) outbound connections.
//
// Why this exists: a host that publishes AAAA records is unreachable over v6
// from a box that HAS a v6 address but no working v6 route. The OS resolver
// can't know the route is dead — glibc's RFC 6724 sorting returns the AAAA
// first, Node follows it, and the request hangs until the timeout while curl
// on the same box succeeds (curl has always raced both families).
//
// These tests stub dns.lookup rather than hitting the network, because the
// interesting input — a MIXED v4/v6 result set with v6 first — is exactly what
// a CI box or a dev machine without IPv6 will never produce naturally. Testing
// against real DNS on such a host passes vacuously: there are no AAAA records
// to mis-order, so the assertion proves nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { ipv4FirstLookup } from "./proxy-agent";

interface Addr {
  address: string;
  family: number;
}

// The v6-first ordering a Linux resolver hands back for a dual-stack host.
const MIXED: Addr[] = [
  { address: "2408:400a:3e:ef00::1", family: 6 },
  { address: "2408:400a:3e:ef03::2", family: 6 },
  { address: "39.106.80.255", family: 4 },
  { address: "39.106.104.16", family: 4 },
];

// Swap dns.lookup for one returning `list`, run `fn`, always restore.
async function withStubbedDns<T>(
  list: Addr[],
  fn: () => Promise<T>,
): Promise<T> {
  const original = dns.lookup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns as any).lookup = (_host: string, opts: any, cb: any) => {
    const o = typeof opts === "function" ? {} : (opts ?? {});
    const done = typeof opts === "function" ? opts : cb;
    const filtered = o.family
      ? list.filter((a) => a.family === o.family)
      : list;
    if (o.all) return done(null, filtered);
    if (!filtered.length)
      return done(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    return done(null, filtered[0].address, filtered[0].family);
  };
  try {
    return await fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dns as any).lookup = original;
  }
}

function lookup(opts: object): Promise<{
  addresses?: Addr[];
  address?: string;
  family?: number;
  error?: string;
}> {
  return new Promise((resolve) =>
    (
      ipv4FirstLookup as unknown as (
        h: string,
        o: object,
        cb: (e: Error | null, a?: unknown, f?: number) => void,
      ) => void
    )("dual.example", opts, (err, a, f) => {
      if (err) return resolve({ error: err.message });
      if (Array.isArray(a)) return resolve({ addresses: a as Addr[] });
      resolve({ address: a as string, family: f });
    }),
  );
}

test("ipv4FirstLookup: IPv6 is REMOVED from a dual-stack result, not just sorted", async () => {
  await withStubbedDns(MIXED, async () => {
    const { addresses } = await lookup({ all: true });
    assert.ok(addresses);
    // Sorting v4-first is NOT enough, and is in fact the ordering that trips
    // Node's autoSelectFamily into an empty-message ETIMEDOUT when the v6 side
    // is unroutable (measured: mixed v4-first fails, v4-only succeeds). The v6
    // entries must be absent, not merely last.
    assert.ok(
      addresses.every((a) => a.family === 4),
      `expected v4 only, got ${JSON.stringify(addresses)}`,
    );
  });
});

test("ipv4FirstLookup: all IPv4 addresses are kept so Happy Eyeballs can race them", async () => {
  await withStubbedDns(MIXED, async () => {
    const { addresses } = await lookup({ all: true });
    // Filtering the family must not collapse to a single address — one dead IP
    // within the chosen family still has to be survivable.
    assert.equal(addresses?.length, 2);
  });
});

test("ipv4FirstLookup: single-result form returns an IPv4 address", async () => {
  await withStubbedDns(MIXED, async () => {
    const { address, family } = await lookup({});
    assert.equal(family, 4);
    assert.ok(address?.includes("."), `expected a v4 literal, got ${address}`);
  });
});

test("ipv4FirstLookup: an explicit family pin is honored, not reordered", async () => {
  await withStubbedDns(MIXED, async () => {
    // family:6 is the caller's deliberate choice — overriding it would make
    // the preference impossible to opt out of.
    const { addresses, address } = await lookup({ family: 6, all: true });
    const got = addresses ?? (address ? [{ address, family: 6 }] : []);
    assert.ok(got.length > 0);
    assert.ok(got.every((a) => a.family === 6));
  });
});

test("ipv4FirstLookup: a v6-only host still resolves (nothing to prefer)", async () => {
  const v6only = MIXED.filter((a) => a.family === 6);
  await withStubbedDns(v6only, async () => {
    const { addresses } = await lookup({ all: true });
    // The preference filters; it must never make a v6-only host unreachable.
    assert.equal(addresses?.length, 2);
    assert.ok(addresses?.every((a) => a.family === 6));
  });
});

test("ipv4FirstLookup: a v4-only host still resolves", async () => {
  const v4only = MIXED.filter((a) => a.family === 4);
  await withStubbedDns(v4only, async () => {
    const { addresses } = await lookup({ all: true });
    assert.equal(addresses?.length, 2);
    assert.ok(addresses?.every((a) => a.family === 4));
  });
});

test("ipv4FirstLookup: a resolution failure surfaces as an error", async () => {
  await withStubbedDns([], async () => {
    const { error } = await lookup({ all: true });
    assert.ok(error, "expected an error for an unresolvable host");
  });
});
