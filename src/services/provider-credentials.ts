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
import {
  ProviderReauthRequiredError,
  type ProviderAuthAccount,
  type ProviderAuthIntegration,
} from "./provider-auth/types";

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

// The flat string-keyed keyMetadata a managed-auth credential's account
// resolves to - the ONE place this mapping is defined. Consumed by
// ProviderCredentialService.handle() (the live request path) AND
// admin/routes/usage-report.ts (the usage-dashboard report path), which
// need the identical shape: an adapter's keyUsage()/messages() override
// reads the same ctx.keyMetadata keys regardless of which path built them.
// Before this was factored out, usage-report.ts built its own narrower
// object by hand and silently drifted from handle()'s - a report request
// would see a metadata shape missing tokenKind/authKind/scopes/etc. that a
// live gateway request would see, so an adapter's keyUsage() eligibility
// check (e.g. claude-code.ts's canQueryUsage) could pass on the request
// path and silently fail on the report path, or vice versa.
export function managedCredentialMetadata(
  integrationId: string,
  account: ProviderAuthAccount,
): Record<string, string> {
  return {
    integrationId,
    accountId: account.accountId ?? "",
    email: account.email ?? "",
    // account_uuid: claude-code's normalize-device-id request transform
    // (formats/anthropic/subscription/index.ts) reads this exact key off
    // ctx.keyMetadata to stamp the real account identity instead of the
    // gateway's default placeholder - same value as accountId, just under
    // the name that transform already looks for.
    ...(account.accountId ? { account_uuid: account.accountId } : {}),
    ...(account.tokenKind ? { tokenKind: account.tokenKind } : {}),
    ...(account.authKind ? { authKind: account.authKind } : {}),
    // keyMetadata values are flat strings (Record<string, string>) - scopes
    // is joined here and split back apart by claude-code.ts's keyUsage(),
    // its only consumer.
    ...(account.scopes?.length ? { scopes: account.scopes.join(",") } : {}),
    ...(account.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
    ...(account.rateLimitTier ? { rateLimitTier: account.rateLimitTier } : {}),
  };
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
      // Cookie-derived credentials (no refresh token) cannot be refreshed -
      // fail fast with the same "must reconnect" signal integration.refresh()
      // uses, so the catch block below marks the row reauth_required exactly
      // once, in one place.
      if (!stored.credential.secrets.refreshToken)
        throw new ProviderReauthRequiredError(
          "Provider authentication cannot be refreshed; please re-import the session",
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
      // Only a refresh token classified as genuinely dead (expired, revoked,
      // reused, or an explicit invalid_grant/401) forces reconnection. Any
      // other failure - a network blip, a 5xx from the auth server, a
      // timeout - is transient: the stored credential is left as-is so the
      // next call retries the refresh instead of stranding a working account
      // behind a manual reconnect. This mirrors how the Codex CLI itself
      // only forces re-login on a classified-permanent refresh failure.
      if (error instanceof ProviderReauthRequiredError)
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
      metadata: managedCredentialMetadata(stored.integrationId, stored.account),
    };
  }
}
