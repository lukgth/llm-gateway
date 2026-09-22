import type { Database as DB } from "better-sqlite3";
import type { ProviderTestProbe } from "../types/provider-auth";
import {
  getProviderOAuth,
  getProviderOAuthView,
  listAllProviderOAuthViews,
  listProviderOAuthAdminViews,
  listProviderOAuthViews,
  listSelectableProviderOAuthHealthKeys,
  markProviderOAuthReauthRequired,
  rotateProviderOAuth,
  type ProviderOAuthView,
} from "../repo/provider-oauth";
import type { ProviderAuthCrypto } from "./provider-auth/crypto";
import { providerAuthIntegrationById } from "./provider-auth/registry";
import type { ProviderAuthIntegration } from "./provider-auth/types";

export interface ProviderCredentialHandle {
  source: "api-key" | "oauth";
  value: string;
  healthKey: string;
  mask: string;
  metadata: Readonly<Record<string, string>>;
}

function accountIdFromHealthKey(healthKey: string): string | null {
  return healthKey.startsWith("oauth:") ? healthKey.slice("oauth:".length) : null;
}

export class ProviderCredentialService {
  private readonly refreshes = new Map<
    string,
    Promise<ProviderCredentialHandle>
  >();
  // Account id -> earliest next revival attempt. Failed revival refreshes back
  // off in-memory so a dead refresh token is not re-posted every sweep.
  private readonly revivalBackoff = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly crypto: ProviderAuthCrypto,
    private readonly integrationById: (
      integrationId: string,
    ) => ProviderAuthIntegration | undefined = providerAuthIntegrationById,
  ) {}

  views(providerId: string): ProviderOAuthView[] {
    return listProviderOAuthViews(this.db, providerId);
  }

  adminViews(providerId: string) {
    return listProviderOAuthAdminViews(this.db, this.crypto, providerId);
  }

  candidates(providerId: string): string[] {
    return listSelectableProviderOAuthHealthKeys(this.db, providerId);
  }

  async testManaged(
    providerId: string,
    accountId?: string,
  ): Promise<ProviderTestProbe> {
    const view = accountId
      ? getProviderOAuthView(this.db, providerId, accountId)
      : listProviderOAuthViews(this.db, providerId)[0] ?? null;
    if (!view) throw new Error("Provider authentication is not connected");
    if (view.status === "disabled")
      return {
        ok: false,
        status: null,
        ms: 0,
        error: "Provider authentication is disabled",
        models: [],
      };
    if (view.status === "reauth_required") {
      // Attempt revival from the stored refresh token instead of failing
      // outright; success flips the row active and testing proceeds below.
      try {
        await this.resolveManaged(providerId, view.id);
      } catch (error) {
        return {
          ok: false,
          status: null,
          ms: 0,
          error: (error as Error).message,
          models: [],
        };
      }
    }

    const resolved = await this.resolveManaged(providerId, view.id);
    if (!resolved) throw new Error("Provider authentication is not connected");
    let result = await this.testCredential(providerId, view.id);
    if (result.status !== 401 && result.status !== 403) return result;

    const refreshed = await this.resolveManaged(providerId, view.id, true);
    if (!refreshed) throw new Error("Provider authentication is not connected");
    result = await this.testCredential(providerId, view.id);
    if (result.status === 401 || result.status === 403)
      markProviderOAuthReauthRequired(this.db, providerId, view.id);
    return result;
  }

  async resolveManaged(
    providerId: string,
    accountId?: string,
    forceRefresh = false,
  ): Promise<ProviderCredentialHandle | null> {
    const healthKey = accountId ? undefined : this.candidates(providerId)[0];
    const resolvedId = accountId ??
      (healthKey ? accountIdFromHealthKey(healthKey) : null);
    if (!resolvedId) return null;
    const view = getProviderOAuthView(this.db, providerId, resolvedId);
    if (!view) return null;
    if (view.status === "disabled")
      throw new Error("Provider authentication is disabled");
    const stored = getProviderOAuth(this.db, this.crypto, providerId, resolvedId);
    if (!stored) return null;
    // reauth_required rows revive automatically when a refresh token survived;
    // cookie-derived rows without one still demand a manual reconnect.
    const revive = view.status === "reauth_required";
    if (revive && !stored.credential.secrets.refreshToken)
      throw new Error("Provider authentication must be reconnected");
    const needsRefresh =
      revive ||
      forceRefresh ||
      stored.credential.expiresAt <= Date.now() + 5 * 60_000;
    if (!needsRefresh) return this.handle(stored);
    const running = this.refreshes.get(stored.id);
    if (running) return running;
    const work = this.refresh(stored).finally(() =>
      this.refreshes.delete(stored.id),
    );
    this.refreshes.set(stored.id, work);
    return work;
  }

  async resolveHealthKey(
    providerId: string,
    healthKey: string,
    forceRefresh = false,
  ): Promise<ProviderCredentialHandle | null> {
    const accountId = accountIdFromHealthKey(healthKey);
    if (!accountId) return null;
    return this.resolveManaged(providerId, accountId, forceRefresh);
  }

  rejectHealthKey(providerId: string, healthKey: string): void {
    const accountId = accountIdFromHealthKey(healthKey);
    if (accountId)
      markProviderOAuthReauthRequired(this.db, providerId, accountId);
  }

  // Background sweep: proactively refresh access tokens nearing expiry and
  // revive reauth_required rows from their stored refresh token. Never throws;
  // per-row failures are counted. Revival failures back off for 30 minutes.
  async sweepTokenRefreshes(): Promise<{ refreshed: number; failed: number }> {
    let refreshed = 0;
    let failed = 0;
    for (const [providerId, views] of listAllProviderOAuthViews(this.db)) {
      for (const view of views) {
        if (view.status === "disabled") continue;
        if (this.refreshes.has(view.id)) continue;
        const revive = view.status === "reauth_required";
        if (revive && Date.now() < (this.revivalBackoff.get(view.id) ?? 0))
          continue;
        const stored = getProviderOAuth(
          this.db,
          this.crypto,
          providerId,
          view.id,
        );
        if (!stored?.credential.secrets.refreshToken) continue;
        const due =
          revive ||
          (view.status === "active" &&
            stored.credential.expiresAt <= Date.now() + 15 * 60_000);
        if (!due) continue;
        const work = this.refresh(stored).finally(() =>
          this.refreshes.delete(stored.id),
        );
        this.refreshes.set(stored.id, work);
        try {
          await work;
          this.revivalBackoff.delete(view.id);
          refreshed++;
        } catch {
          if (revive)
            this.revivalBackoff.set(view.id, Date.now() + 30 * 60_000);
          failed++;
        }
      }
    }
    return { refreshed, failed };
  }

  private async testCredential(
    providerId: string,
    accountId: string,
  ): Promise<ProviderTestProbe> {
    const stored = getProviderOAuth(
      this.db,
      this.crypto,
      providerId,
      accountId,
    );
    if (!stored) throw new Error("Provider authentication is not connected");
    const integration = this.integrationById(stored.integrationId);
    if (!integration)
      throw new Error("Unknown provider authentication integration");
    return integration.test(stored.credential);
  }

  private async refresh(
    stored: NonNullable<ReturnType<typeof getProviderOAuth>>,
  ): Promise<ProviderCredentialHandle> {
    const integration = this.integrationById(stored.integrationId);
    if (!integration)
      throw new Error("Unknown provider authentication integration");
    try {
      // Cookie-derived credentials (no refresh token) cannot be refreshed -
      // fail fast inside the try so the expired-refresh failure path below
      // marks the row reauth_required and the operator knows to re-import.
      if (!stored.credential.secrets.refreshToken)
        throw new Error(
          "Provider authentication cannot be refreshed; please re-import the Codex session",
        );
      const fresh = await integration.refresh(stored.credential);
      if (!rotateProviderOAuth(this.db, this.crypto, stored, fresh)) {
        const latest = getProviderOAuth(
          this.db,
          this.crypto,
          stored.providerId,
          stored.id,
        );
        if (!latest) throw new Error("Provider authentication was removed");
        return this.handle(latest);
      }
      const latest = getProviderOAuth(
        this.db,
        this.crypto,
        stored.providerId,
        stored.id,
      )!;
      return this.handle(latest);
    } catch (error) {
      if (
        !stored.credential.expiresAt ||
        stored.credential.expiresAt <= Date.now()
      )
        markProviderOAuthReauthRequired(
          this.db,
          stored.providerId,
          stored.id,
        );
      throw error;
    }
  }

  private handle(
    stored: NonNullable<ReturnType<typeof getProviderOAuth>>,
  ): ProviderCredentialHandle {
    const integration = this.integrationById(stored.integrationId);
    if (!integration)
      throw new Error("Unknown provider authentication integration");
    return {
      source: "oauth",
      value: integration.runtimeCredential(stored.credential),
      healthKey: `oauth:${stored.id}`,
      mask: stored.account.email || stored.account.label || "Connected account",
      metadata: {
        integrationId: stored.integrationId,
        accountId: stored.account.accountId ?? "",
        email: stored.account.email ?? "",
      },
    };
  }
}
