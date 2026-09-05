// Per-provider + all-providers upstream key-usage reports (the /providers
// and /providers/:id/usage dashboards), built from each adapter's async
// keyUsage() seam.

import type { Database as DB } from "better-sqlite3";
import type {
  Provider,
  ProviderKeyUsage,
  ProviderUsageReport,
} from "../../types";
import { adapterForProvider } from "../../providers";
import { listProviders } from "../../repo/providers";
import { getUnifiedUsage } from "../../repo/provider-key-usage";
import { listProviderKeys, maskProviderKey } from "../../repo/provider-keys";
import { lastUsedByKey } from "../../repo/request-logs";
import { seedFromKey, makeUsageCtx } from "./provider-probe";
import { KeyHealthStore, type KeyHealthSnapshot } from "../../gateway/key-health";
import { listProviderOAuthViews } from "../../repo/provider-oauth";
import { providerAuthIntegration } from "../../services/provider-auth/registry";
import type { ProviderCredentialService } from "../../services/provider-credentials";

// The usage dashboard audits EVERY provider's live keyUsage() probe, and any
// could hang: an unreachable route (blackholed / dropped SYN) stalls in the
// TCP/TLS handshake until the flat 30s interactive probe timeout
// (PROBE_TIMEOUT_MS in provider-probe.ts). Because the report awaits every
// provider before responding, one unreachable provider used to hold the whole
// /providers/usage endpoint past the fronting proxy's read timeout and turn
// the panel into a 504 with nothing rendered. This is the per-provider report
// budget, picked comfortably under the ~10s+ read timeouts common on reverse
// proxies. Healthy-fast adapters (<1s) are unaffected.
const REPORT_BUDGET_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function buildUsageReport(
  p: Provider,
  db: DB,
  providerCredentials?: ProviderCredentialService,
  budgetMs: number = REPORT_BUDGET_MS,
): Promise<ProviderUsageReport> {
  const adapter = adapterForProvider(p);
  const healthStore = new KeyHealthStore(db);
  // Codex-style managed-auth providers hold their credentials as OAuth
  // accounts in provider_oauth_credentials, NOT as provider_keys rows (the
  // engine gates on the same providerAuthIntegration() and reads its key pool
  // from providerCredentials.candidates()). Build report rows from whichever
  // pool this provider actually uses, keyed by the same cred hashes the
  // engine stamps on request logs, so health/last-used attribution lines up.
  const requiresManagedAuth =
    !!p.catalogId && !!providerAuthIntegration(p.catalogId);
  const oauthViews = requiresManagedAuth
    ? listProviderOAuthViews(db, p.id)
    : [];
  const lastUsed = lastUsedByKey(db, p.id);
  const rows = requiresManagedAuth
    ? oauthViews.map((view) => {
        const h = healthStore.snapshot(p.id, view.credHash);
        return {
          // Sent to the adapter so keyUsage() can resolve the live access
          // token (fresh/refreshed) through the same service the engine uses.
          key: `oauth:${view.id}`,
          enabled: view.status === "active",
          metadata: {
            integrationId: view.integrationId,
            accountId: view.account.accountId ?? "",
            email: view.account.email ?? "",
          },
          keyHash: view.credHash,
          lastUsedAt: lastUsed.get(view.credHash),
          health: snapshotToHealth(h),
        };
      })
    : listProviderKeys(db, p.id).map((k) => {
        const h = healthStore.snapshot(p.id, k.credHash);
        return {
          key: k.credential,
          enabled: k.enabled,
          metadata: k.metadata,
          keyHash: k.credHash,
          lastUsedAt: lastUsed.get(k.credHash),
          health: snapshotToHealth(h),
        };
      });

  // Visibility gate: if the adapter doesn't report usage at all, skip the per-key
  // queries and return an empty, unsupported report. The dashboard drops these;
  // the per-provider view uses `supported` to show a "not reported" note. The
  // gate sees a representative key (the first row) so it can decide from config.
  const first = rows[0];
  const supported = adapter.supportsKeyUsage({
    provider: p,
    apiKey: first?.key ?? "",
    keyMetadata: first?.metadata ?? {},
    mask: first ? maskProviderKey(first.key) : "",
    enabled: first?.enabled ?? true,
    seed: first ? seedFromKey(first.key) : 0,
    ...makeUsageCtx(p),
  });
  if (!supported) {
    return {
      providerId: p.id,
      providerName: p.name,
      catalogId: p.catalogId,
      brand: adapter.brand,
      supported: false,
      dummy: false,
      keys: [],
    };
  }

  let anyDummy = false;
  const runQueries = async () =>
    Promise.all(
      rows.map(
        async ({ key, enabled, metadata, keyHash, health, lastUsedAt }) => {
          const mask = managedKeyMask(metadata) ?? maskProviderKey(key);
          let accessToken = key;
          if (requiresManagedAuth && providerCredentials) {
            // Resolve (and refresh if needed) through the shared service -
            // the same path the engine's live requests use. A resolution
            // failure surfaces as an unavailable key, never a failed report.
            try {
              const handle = await providerCredentials.resolveHealthKey(
                p.id,
                key,
              );
              if (!handle) throw new Error("credential not resolvable");
              accessToken = handle.value;
            } catch (e) {
              return {
                keyMask: mask,
                enabled,
                health,
                windows: [],
                ...(lastUsedAt ? { lastUsedAt } : {}),
                unavailable: true,
                message: `Credential unavailable: ${(e as Error).message}`,
              };
            }
          }
          try {
            const { windows, expiresAt, dummy, unavailable, message } =
              await adapter.keyUsage({
                provider: p,
                apiKey: accessToken,
                keyMetadata: metadata,
                mask,
                enabled,
                seed: seedFromKey(key),
                unifiedUsage: getUnifiedUsage(db, p.id, keyHash),
                ...makeUsageCtx(p),
              });
            if (dummy) anyDummy = true;
            return {
              keyMask: mask,
              enabled,
              health,
              windows,
              ...(lastUsedAt ? { lastUsedAt } : {}),
              ...(expiresAt ? { expiresAt } : {}),
              ...(unavailable ? { unavailable: true } : {}),
              ...(message ? { message } : {}),
            };
          } catch (e) {
            // An adapter's live query threw - surface it as an unavailable key with
            // the error detail rather than failing the whole page.
            return {
              keyMask: mask,
              enabled,
              health,
              windows: [],
              ...(lastUsedAt ? { lastUsedAt } : {}),
              unavailable: true,
              message: `Usage query failed: ${(e as Error).message}`,
            };
          }
        },
      ),
    );

  // Cap how long this provider may hold up the report. Run the real keyUsage()
  // queries but, if they haven't answered within budgetMs, degrade every key to
  // an unavailable placeholder so the provider stays visible + identifiable
  // instead of stalling the whole panel. The abandoned queries keep running
  // until their 30s probe timeout; their results are discarded.
  const keys = await Promise.race([
    runQueries(),
    delay(budgetMs).then(() =>
      rows.map(({ key, enabled, metadata, health, lastUsedAt }) => ({
        keyMask: managedKeyMask(metadata) ?? maskProviderKey(key),
        enabled,
        health,
        windows: [],
        ...(lastUsedAt ? { lastUsedAt } : {}),
        unavailable: true,
        message: `Usage query timed out after ${budgetMs}ms`,
      })),
    ),
  ]);
  const visibleKeys = keys.filter((key) => {
    // Dead/auth-failed keys don't belong in the usage dashboard - they are shown
    // in the provider Keys table where operators manage credentials. Rate-limited
    // keys stay visible because their usage/quota windows are still relevant.
    if (key.health?.dead) return false;
    const hasUsageHealthState = !!key.health?.rateLimitedUntil;
    if (!key.enabled && !hasUsageHealthState) return false;
    // Passive Claude Code usage is meaningful only after a real request has
    // produced unified quota headers; hide unrecorded rows to avoid clutter unless
    // the row explains an active rate-limit cooldown.
    if (
      p.catalogId === "claude-code" &&
      key.unavailable &&
      !hasUsageHealthState
    )
      return false;
    return true;
  });
  return {
    providerId: p.id,
    providerName: p.name,
    catalogId: p.catalogId,
    brand: adapter.brand,
    supported: true,
    dummy: anyDummy,
    keys: visibleKeys,
  };
}

// OAuth account rows are identified by their account email/label, not a masked
// secret - the same display the credential handle's `mask` uses (the raw value
// is an encrypted-at-rest JWT, and `oauth:<id>` would leak nothing useful).
function managedKeyMask(
  metadata: Readonly<Record<string, string>>,
): string | undefined {
  const mask = metadata.email || metadata.accountId;
  return mask ? mask : undefined;
}

function snapshotToHealth(h: KeyHealthSnapshot): ProviderKeyUsage["health"] {
  return {
    usable: h.usable,
    dead: h.authFailed,
    ...(h.rateLimitedUntilIso ? { rateLimitedUntil: h.rateLimitedUntilIso } : {}),
    ...(h.lastErrorStatus !== null ? { lastErrorStatus: h.lastErrorStatus } : {}),
    ...(h.lastError ? { lastError: h.lastError } : {}),
    ...(h.lastErrorAt ? { lastErrorAt: h.lastErrorAt } : {}),
  };
}

// All providers' reports (the /providers/usage dashboard), built in parallel.
// Providers whose adapter doesn't report usage (supportsKeyUsage() = false) are
// omitted entirely - the dashboard only lists providers that have something to
// show, rather than a wall of empty cards.
export async function buildUsageReports(
  db: DB,
  providerCredentials?: ProviderCredentialService,
): Promise<ProviderUsageReport[]> {
  const reports = await Promise.all(
    listProviders(db).map((p) => buildUsageReport(p, db, providerCredentials)),
  );
  return reports.filter((r) => r.supported && r.keys.length > 0);
}
