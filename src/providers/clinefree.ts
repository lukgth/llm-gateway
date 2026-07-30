import { randomUUID } from "crypto";
import type { UpstreamModel } from "../formats/wire/models";

export const CLINE_API_BASE_URL = "https://api.cline.bot";
export const CLINE_BASE_PATH = "/api/v1";
export const CLINE_CHAT_URL = `${CLINE_API_BASE_URL}${CLINE_BASE_PATH}/chat/completions`;
export const CLINE_MODELS_URL = `${CLINE_API_BASE_URL}${CLINE_BASE_PATH}/ai/cline/recommended-models`;
export const CLINE_REGISTER_URL = `${CLINE_API_BASE_URL}${CLINE_BASE_PATH}/auth/register`;
export const CLINE_REFRESH_URL = `${CLINE_API_BASE_URL}${CLINE_BASE_PATH}/auth/refresh`;
export const CLINE_CLIENT_VERSION = "3.0.47";
export const CLINE_CORE_VERSION = "0.0.66";

export interface ClineFreeModel extends UpstreamModel {
  description?: string;
}

export const STATIC_CLINE_FREE_MODELS: ClineFreeModel[] = [
  {
    id: "cline-free/glm-5.2",
    displayName: "GLM 5.2",
    description: "Z.ai's frontier open weights model",
  },
  {
    id: "poolside/laguna-s-2.1:free",
    displayName: "Laguna S 2.1",
    description: "Latest coding agent model from Poolside",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    description: "Fast and efficient with 1M context window",
  },
  {
    id: "stepfun/step-3.7-flash",
    displayName: "Step 3.7 Flash",
    description: "Fast vision capable model built for agents",
  },
];

export function formatClineAccessToken(accessToken: string): string {
  return accessToken.toLowerCase().startsWith("workos:")
    ? accessToken
    : `workos:${accessToken}`;
}

export function clineFingerprintHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${formatClineAccessToken(accessToken)}`,
    "content-type": "application/json",
    "http-referer": "https://cline.bot",
    "x-title": "Cline",
    "user-agent": `Cline/${CLINE_CLIENT_VERSION}`,
    "x-client-type": "cline-cli",
    "x-client-version": CLINE_CLIENT_VERSION,
    "x-platform": "cli",
    "x-platform-version": CLINE_CLIENT_VERSION,
    "x-core-version": CLINE_CORE_VERSION,
    "x-is-multiroot": "false",
    "x-task-id": randomUUID(),
  };
}

export function parseClineFreeModels(body: unknown): ClineFreeModel[] {
  const free = (body as { free?: unknown } | null)?.free;
  if (!Array.isArray(free)) return [];
  const out: ClineFreeModel[] = [];
  for (const raw of free) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id.trim()) continue;
    out.push({
      id: entry.id,
      displayName:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name
          : entry.id,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      ...(typeof entry.contextWindow === "number" && entry.contextWindow > 0
        ? { contextWindow: entry.contextWindow }
        : {}),
      ...(typeof entry.maxOutputTokens === "number" &&
      entry.maxOutputTokens > 0
        ? { maxOutputTokens: entry.maxOutputTokens }
        : {}),
      raw: entry,
    });
  }
  return out;
}

export function isClineFreeLimitError(body: string): boolean {
  return body.toLowerCase().includes("free limit reached on model");
}

export function extractClineRetryTime(body: string): string | undefined {
  return body.match(/try again in ([^.]+)/i)?.[1]?.trim();
}

export function clineRetryDelayMs(body: string): number | undefined {
  const text = extractClineRetryTime(body);
  if (!text) return undefined;
  const match = text.match(/([\d.]+)\s*(second|minute|hour|day)s?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2].toLowerCase();
  const scale =
    unit === "second"
      ? 1_000
      : unit === "minute"
        ? 60_000
        : unit === "hour"
          ? 3_600_000
          : 86_400_000;
  return Math.round(value * scale);
}
