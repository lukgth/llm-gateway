import type { Database as DB } from "better-sqlite3";
import type { ProviderTestProbe } from "../types/provider-auth";
import {
  getProviderOAuth,
  getProviderOAuthView,
  listActiveProviderOAuthHealthKeys,
  listProviderOAuthAdminViews,
  listProviderOAuthViews,
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
    return listActiveProviderOAuthHealthKeys(this.db, providerId);
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
    if (view.status === "reauth_required")
      return {
        ok: false,
        status: null,
        ms: 0,
        error: "Provider authentication must be reconnected",
        models: [],
      };

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
    if (view.status === "reauth_required")
      throw new Error("Provider authentication must be reconnected");
    const stored = getProviderOAuth(this.db, this.crypto, providerId, resolvedId);
    if (!stored) return null;
    const needsRefresh =
      forceRefresh || stored.credential.expiresAt <= Date.now() + 5 * 60_000;
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
