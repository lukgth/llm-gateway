import type { ProviderTestProbe } from "../../types/provider-auth";

export type ProviderAuthState =
  | "pending"
  | "ready"
  | "denied"
  | "expired"
  | "failed"
  | "cancelled"
  | "consumed";

export interface ProviderAuthSecrets {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

export interface ProviderAuthAccount {
  accountId?: string;
  email?: string;
  label?: string;
}

export interface ProviderAuthCredential {
  integrationId: string;
  secrets: ProviderAuthSecrets;
  expiresAt: number;
  account: ProviderAuthAccount;
}

export interface ProviderAuthBeginResult {
  transaction: unknown;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}

export type ProviderAuthPollResult =
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "denied"; message: string }
  | { state: "expired"; message: string }
  | { state: "failed"; message: string }
  | { state: "ready"; credential: ProviderAuthCredential };

// A credential supplied directly by an administrator instead of acquired
// through an interactive flow - e.g. pasting an existing auth.json or a raw
// session cookie. Only integrations that declare `import` accept these.
export interface ProviderAuthImport {
  kind: "auth_json" | "session_cookie" | "callback_url";
  value: string;
}

export interface ProviderAuthIntegration {
  id: string;
  catalogId: string;
  begin(): Promise<ProviderAuthBeginResult>;
  poll(transaction: unknown): Promise<ProviderAuthPollResult>;
  refresh(credential: ProviderAuthCredential): Promise<ProviderAuthCredential>;
  runtimeCredential(credential: ProviderAuthCredential): string;
  test(credential: ProviderAuthCredential): Promise<ProviderTestProbe>;
  import?(input: ProviderAuthImport): Promise<ProviderAuthCredential>;
}

export interface ProviderAuthSessionView {
  id: string;
  catalogId: string;
  state: ProviderAuthState;
  flow: "device_code" | "import";
  expiresAt: string;
  nextPollAt?: string;
  verification?: {
    uri: string;
    uriComplete?: string;
    userCode: string;
  };
  account?: ProviderAuthAccount;
  error?: { code: string; message: string };
}
