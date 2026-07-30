import { randomBytes } from "crypto";
import type { Database as DB } from "better-sqlite3";
import {
  createProviderOAuth,
  replaceProviderOAuth,
  type ProviderOAuthView,
} from "../../repo/provider-oauth";
import type { ProviderAuthCrypto } from "./crypto";
import { providerAuthIntegration } from "./registry";
import type {
  ProviderAuthCredential,
  ProviderAuthIntegration,
  ProviderAuthSessionView,
  ProviderAuthState,
} from "./types";

interface Session {
  id: string;
  owner: string;
  integration: ProviderAuthIntegration;
  transaction: unknown;
  state: ProviderAuthState;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  credential?: ProviderAuthCredential;
  error?: { code: string; message: string };
}

type ReadySession = Session & { credential: ProviderAuthCredential };

export class ProviderAuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly polls = new Map<string, Promise<ProviderAuthSessionView>>();

  constructor(
    private readonly db: DB,
    private readonly crypto: ProviderAuthCrypto,
    private readonly integrationForCatalog: (
      catalogId: string,
    ) => ProviderAuthIntegration | undefined = providerAuthIntegration,
  ) {}

  async begin(
    catalogId: string,
    owner: string,
  ): Promise<ProviderAuthSessionView> {
    this.sweep();
    const integration = this.integrationForCatalog(catalogId);
    if (!integration)
      throw new Error("Provider does not support managed authentication");
    const started = await integration.begin();
    const id = randomBytes(32).toString("base64url");
    const session: Session = {
      id,
      owner,
      integration,
      transaction: started.transaction,
      state: "pending",
      expiresAt: started.expiresAt,
      intervalMs: Math.max(1_000, started.intervalMs),
      nextPollAt: Date.now() + Math.max(1_000, started.intervalMs),
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete,
      userCode: started.userCode,
    };
    this.sessions.set(id, session);
    return this.view(session);
  }

  get(id: string, owner: string): ProviderAuthSessionView {
    return this.view(this.owned(id, owner));
  }

  poll(id: string, owner: string): Promise<ProviderAuthSessionView> {
    const session = this.owned(id, owner);
    if (session.state !== "pending") return Promise.resolve(this.view(session));
    if (Date.now() >= session.expiresAt) {
      session.state = "expired";
      session.transaction = null;
      session.error = { code: "expired", message: "The device code expired." };
      return Promise.resolve(this.view(session));
    }
    if (Date.now() < session.nextPollAt)
      return Promise.resolve(this.view(session));
    const current = this.polls.get(id);
    if (current) return current;
    const work = this.advance(session).finally(() => this.polls.delete(id));
    this.polls.set(id, work);
    return work;
  }

  private async advance(session: Session): Promise<ProviderAuthSessionView> {
    session.nextPollAt = Date.now() + session.intervalMs;
    try {
      const result = await session.integration.poll(session.transaction);
      switch (result.state) {
        case "pending":
          break;
        case "slow_down":
          session.intervalMs += 1_000;
          session.nextPollAt = Date.now() + session.intervalMs;
          break;
        case "ready":
          session.state = "ready";
          session.credential = result.credential;
          session.transaction = null;
          break;
        default:
          session.state = result.state;
          session.transaction = null;
          session.error = { code: result.state, message: result.message };
      }
    } catch {
      session.state = "failed";
      session.transaction = null;
      session.error = {
        code: "exchange_failed",
        message: "Authentication could not be completed. Please try again.",
      };
    }
    return this.view(session);
  }

  async test(id: string, owner: string) {
    const session = this.ready(id, owner);
    return session.integration.test(session.credential);
  }

  adoptForNewProvider(
    id: string,
    owner: string,
    providerId: string,
    catalogId: string,
  ): ProviderOAuthView {
    const session = this.ready(id, owner);
    if (session.integration.catalogId !== catalogId)
      throw new Error("Authentication session does not match the provider");
    const view = createProviderOAuth(
      this.db,
      this.crypto,
      providerId,
      session.credential,
    );
    this.consume(session);
    return view;
  }

  addAccount(
    id: string,
    owner: string,
    providerId: string,
    catalogId: string | null,
  ): ProviderOAuthView {
    const session = this.ready(id, owner);
    if (!catalogId || session.integration.catalogId !== catalogId)
      throw new Error("Authentication session does not match the provider");
    const view = createProviderOAuth(
      this.db,
      this.crypto,
      providerId,
      session.credential,
    );
    this.consume(session);
    return view;
  }

  reconnect(
    id: string,
    owner: string,
    providerId: string,
    accountId: string,
    catalogId: string | null,
  ): ProviderOAuthView {
    const session = this.ready(id, owner);
    if (!catalogId || session.integration.catalogId !== catalogId)
      throw new Error("Authentication session does not match the provider");
    const view = replaceProviderOAuth(
      this.db,
      this.crypto,
      providerId,
      accountId,
      session.credential,
    );
    this.consume(session);
    return view;
  }

  cancel(id: string, owner: string): void {
    const session = this.owned(id, owner);
    if (session.state === "consumed") return;
    session.state = "cancelled";
    session.transaction = null;
    session.credential = undefined;
  }

  private consume(session: Session): void {
    session.state = "consumed";
    session.transaction = null;
    session.credential = undefined;
  }

  private ready(id: string, owner: string): ReadySession {
    const session = this.owned(id, owner);
    if (session.state !== "ready" || !session.credential)
      throw new Error("Authentication is not ready");
    if (Date.now() >= session.expiresAt)
      throw new Error("Authentication session expired");
    return session as ReadySession;
  }

  private owned(id: string, owner: string): Session {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner)
      throw new Error("Authentication session not found");
    return session;
  }

  private view(session: Session): ProviderAuthSessionView {
    return {
      id: session.id,
      catalogId: session.integration.catalogId,
      flow: "device_code",
      state: session.state,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.state === "pending"
        ? {
            nextPollAt: new Date(session.nextPollAt).toISOString(),
            verification: {
              uri: session.verificationUri,
              ...(session.verificationUriComplete
                ? { uriComplete: session.verificationUriComplete }
                : {}),
              userCode: session.userCode,
            },
          }
        : {}),
      ...(session.state === "ready" && session.credential
        ? { account: session.credential.account }
        : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }

  private sweep(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < cutoff) this.sessions.delete(id);
      else if (session.state === "pending" && Date.now() >= session.expiresAt) {
        session.state = "expired";
        session.transaction = null;
        session.error = { code: "expired", message: "The device code expired." };
      }
    }
  }
}
