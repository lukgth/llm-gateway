import {
  CLINE_CHAT_URL,
  CLINE_MODELS_URL,
  CLINE_REFRESH_URL,
  CLINE_REGISTER_URL,
  STATIC_CLINE_FREE_MODELS,
  clineFingerprintHeaders,
  formatClineAccessToken,
  parseClineFreeModels,
} from "../../../providers/clinefree";
import type {
  ProviderAuthBeginResult,
  ProviderAuthCredential,
  ProviderAuthIntegration,
  ProviderAuthPollResult,
} from "../types";

const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const WORKOS_DEVICE_URL = "https://api.workos.com/user_management/authorize/device";
const WORKOS_AUTH_URL = "https://api.workos.com/user_management/authenticate";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000;

interface ClineTransaction {
  deviceCode: string;
}

interface WorkOSTokens {
  accessToken: string;
  refreshToken: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(
  value: unknown,
  field: string,
  context: string,
): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${context} response (${field})`);
  return value;
}

async function readJsonLimited(
  res: Response,
): Promise<Record<string, unknown>> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    throw new Error("Authentication response too large");
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new Error("Authentication response too large");
  try {
    return record(JSON.parse(text));
  } catch {
    throw new Error("Authentication service returned invalid JSON");
  }
}

async function fixedFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function clineCredential(
  payload: Record<string, unknown>,
): ProviderAuthCredential {
  const data = record(payload.data);
  const info = record(data.userInfo);
  const expiresAt = Date.parse(
    requiredString(data.expiresAt, "expiresAt", "Cline"),
  );
  if (!Number.isFinite(expiresAt)) throw new Error("Invalid Cline token expiry");
  return {
    integrationId: "clinefree",
    secrets: {
      accessToken: requiredString(data.accessToken, "accessToken", "Cline"),
      refreshToken: requiredString(data.refreshToken, "refreshToken", "Cline"),
    },
    expiresAt,
    account: {
      accountId:
        typeof info.clineUserId === "string" ? info.clineUserId : undefined,
      email: typeof info.email === "string" ? info.email : undefined,
      label: typeof info.name === "string" ? info.name : undefined,
    },
  };
}

async function registerWithCline(
  workos: WorkOSTokens,
): Promise<ProviderAuthCredential> {
  const res = await fixedFetch(CLINE_REGISTER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accessToken: workos.accessToken,
      refreshToken: workos.refreshToken,
    }),
  });
  const payload = await readJsonLimited(res);
  if (!res.ok || payload.success !== true)
    throw new Error(`Cline registration failed (${res.status})`);
  return clineCredential(payload);
}

async function discoverModels(): Promise<typeof STATIC_CLINE_FREE_MODELS> {
  try {
    const res = await fixedFetch(CLINE_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return STATIC_CLINE_FREE_MODELS;
    const models = parseClineFreeModels(await readJsonLimited(res));
    return models.length ? models : STATIC_CLINE_FREE_MODELS;
  } catch {
    return STATIC_CLINE_FREE_MODELS;
  }
}

export const clinefreeAuth: ProviderAuthIntegration = {
  id: "clinefree",
  catalogId: "clinefree",

  async begin(): Promise<ProviderAuthBeginResult> {
    const res = await fixedFetch(WORKOS_DEVICE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
    });
    const payload = await readJsonLimited(res);
    if (!res.ok) throw new Error(`Device authorization failed (${res.status})`);
    const expiresIn =
      typeof payload.expires_in === "number" && payload.expires_in > 0
        ? payload.expires_in
        : 300;
    const interval =
      typeof payload.interval === "number" && payload.interval > 0
        ? payload.interval
        : 5;
    return {
      transaction: {
        deviceCode: requiredString(
          payload.device_code,
          "device_code",
          "WorkOS device authorization",
        ),
      } satisfies ClineTransaction,
      verificationUri: requiredString(
        payload.verification_uri,
        "verification_uri",
        "WorkOS device authorization",
      ),
      verificationUriComplete:
        typeof payload.verification_uri_complete === "string"
          ? payload.verification_uri_complete
          : undefined,
      userCode: requiredString(
        payload.user_code,
        "user_code",
        "WorkOS device authorization",
      ),
      expiresAt: Date.now() + expiresIn * 1000,
      intervalMs: interval * 1000,
    };
  },

  async poll(transaction: unknown): Promise<ProviderAuthPollResult> {
    const deviceCode = requiredString(
      (transaction as ClineTransaction | null)?.deviceCode,
      "deviceCode",
      "stored device authorization",
    );
    const res = await fixedFetch(WORKOS_AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: WORKOS_CLIENT_ID,
      }),
    });
    const payload = await readJsonLimited(res);
    if (res.ok) {
      const credential = await registerWithCline({
        accessToken: requiredString(
          payload.access_token,
          "access_token",
          "WorkOS authentication",
        ),
        refreshToken: requiredString(
          payload.refresh_token,
          "refresh_token",
          "WorkOS authentication",
        ),
      });
      return { state: "ready", credential };
    }
    switch (payload.error) {
      case "authorization_pending":
        return { state: "pending" };
      case "slow_down":
        return { state: "slow_down" };
      case "access_denied":
        return { state: "denied", message: "Authorization was denied." };
      case "expired_token":
        return { state: "expired", message: "The device code expired." };
      default:
        return {
          state: "failed",
          message: `Device authorization failed (${res.status}).`,
        };
    }
  },

  async refresh(
    credential: ProviderAuthCredential,
  ): Promise<ProviderAuthCredential> {
    const res = await fixedFetch(CLINE_REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refreshToken: credential.secrets.refreshToken,
        grantType: "refresh_token",
      }),
    });
    const payload = await readJsonLimited(res);
    if (!res.ok || payload.success !== true)
      throw new Error(`Cline token refresh failed (${res.status})`);
    return clineCredential(payload);
  },

  runtimeCredential(credential: ProviderAuthCredential): string {
    return formatClineAccessToken(credential.secrets.accessToken);
  },

  async test(credential: ProviderAuthCredential) {
    const models = await discoverModels();
    const model = models[0]?.id;
    if (!model)
      return { ok: false, status: null, ms: 0, error: "No free models found", models };
    const started = Date.now();
    try {
      const res = await fixedFetch(CLINE_CHAT_URL, {
        method: "POST",
        headers: clineFingerprintHeaders(credential.secrets.accessToken),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with one word." }],
          max_tokens: 2048,
          stream: false,
        }),
      });
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        ms: Date.now() - started,
        ...(res.ok
          ? { sample: text.slice(0, 240) }
          : { error: `Cline test failed (${res.status})` }),
        models,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        ms: Date.now() - started,
        error: (error as Error).message,
        models,
      };
    }
  },
};
