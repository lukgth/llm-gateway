// Global settings - a key/value store with a typed view.

export interface Settings {
  modelPrefix: string;
  exposePrefix: string;
  exposeExempt: string[];
  allowUnknown: boolean;
  defaultMaxOutputTokens: number;
  ssePingInterval: number;
  requestLogRetentionDays: number;
  /** Capture distilled request/response payloads into request logs for
   *  debugging (messages, tools, tool calls, response text). */
  debugLogging: boolean;
  /** Back Anthropic's hosted web_search / web_fetch tools with a web provider so
   *  they work against any upstream model (the gateway runs the tool loop). */
  webToolsEnabled: boolean;
  /** Which web provider backs the tools (registry id, e.g. "firecrawl"). */
  webToolsProvider: string;
  /** Provider base URL override (blank = the provider's default endpoint). */
  webProviderBaseUrl: string;
  /** Optional provider API key (blank = keyless where supported). */
  webProviderApiKey: string;
  /** Message returned in Anthropic-compatible auth errors when a known gateway
   *  API key exists but is disabled/revoked. */
  disabledApiKeyMessage: string;
  /** Master switch for PII redaction. Models opt in individually on top of this. */
  piiEnabled: boolean;
  /** Presidio analyzer base URL (POST /analyze, GET /health). */
  piiAnalyzerUrl: string;
  /** Presidio anonymizer base URL; used by the Settings test button only. */
  piiAnonymizerUrl: string;
  /** Presidio language hint; the analyzer requires one. */
  piiLanguage: string;
  /** Analyzer confidence threshold, 0..1. */
  piiScoreThreshold: number;
  /** Presidio entity types to look for; empty = every entity the analyzer supports. */
  piiEntities: string[];
  /** Analyzer request timeout in milliseconds. */
  piiTimeoutMs: number;
  adminPasswordHash: string | null;
  jwtSecret: string;
}

export const DEFAULT_SETTINGS: Settings = {
  modelPrefix: "",
  exposePrefix: "anthropic/",
  exposeExempt: ["claude"],
  allowUnknown: false,
  defaultMaxOutputTokens: 16384,
  ssePingInterval: 15000,
  requestLogRetentionDays: 30,
  debugLogging: false,
  webToolsEnabled: false,
  webToolsProvider: "firecrawl",
  webProviderBaseUrl: "",
  webProviderApiKey: "",
  disabledApiKeyMessage:
    "Your API key was revoked. Please contact your gateway's administrator for help.",
  piiEnabled: false,
  piiAnalyzerUrl: "",
  piiAnonymizerUrl: "",
  piiLanguage: "en",
  piiScoreThreshold: 0.5,
  piiEntities: [],
  piiTimeoutMs: 10000,
  adminPasswordHash: null,
  jwtSecret: "",
};
