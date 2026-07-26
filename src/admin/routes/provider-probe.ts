// Low-level HTTP probing primitives for provider connectivity tests, model
// discovery, and per-model tests. Shared by both the saved-provider routes
// and the pre-create wizard's ad-hoc probe (which has no id/adapter yet).
//
// Two connectivity-test entry points, deliberately kept separate (see each
// function's own doc comment for why):
//   testProviderAdhoc()   — pre-create wizard, no adapter (ProviderLike only)
//   testSavedProvider()   — saved provider, goes through adapter.testProvider()

import http from "http";
import https from "https";
import { URL } from "url";
import type { Database as DB } from "better-sqlite3";
import type { Provider, ModelTransformConfig } from "../../types";
import {
  adapterForProvider,
  fetchModelList,
  normalizeModels,
  applyAuthHeaders,
  composeUrl,
  endpointPathFor,
  type ModelListTransport,
  type ModelsFormat,
  type ModelsCtx,
  type ResolveUrl,
  type ResolvePath,
  type UpstreamModel,
  type TestModelCtx,
  type TestModelResult,
  type TestProviderCtx,
  type UsageCtx,
  type AdapterRequest,
} from "../../providers";
import { dispatchAgent } from "../../gateway/proxy-agent";
import { shortId } from "../../gateway/engine-support/utils";
import type { Logger } from "../../logger";
import { getSettings } from "../../repo/settings";
import {
  listEnabledCredentials,
  maskProviderKey,
} from "../../repo/provider-keys";
import { type ProviderLike, providerLikeFrom } from "./types";

// Deterministic small hash of a key -> a stable seed for placeholder usage, so
// the same key renders the same bars every load (no random flicker).
export function seedFromKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Compose the model-list URL {origin}{basePath}{modelsPath}, preserving any path
// prefix (e.g. Gemini's /v1beta/openai/models). No format is assumed by the path.
function modelsUrl(p: ProviderLike): string {
  const base = p.baseUrl.replace(/\/+$/, "");
  return base + (p.basePath || "") + (p.modelsPath || "/v1/models");
}

// The provider's request headers for a model-list GET: host + auth (per the
// provider's authScheme) + any configured extraHeaders. `accept` and (for the
// Anthropic dialect) `anthropic-version` are added downstream by fetchModelList.
// `keyOverride` sends a SPECIFIC key (e.g. the one pickKeyForTest picked via
// the live rotation/health state) instead of always the first configured key.
function modelsRequestHeaders(
  p: ProviderLike,
  keyOverride?: string,
): Record<string, string> {
  let host = p.host || "";
  if (!host) {
    try {
      host = new URL(modelsUrl(p)).host;
    } catch {
      host = "";
    }
  }
  const headers: Record<string, string> = { ...p.extraHeaders };
  if (host) headers.host = host;
  return applyAuthHeaders(headers, p.authScheme, keyOverride ?? p.apiKeys[0]);
}

// A never-empty, always-actionable description of a transport failure. Node's
// socket/TLS errors can arrive with an empty `message` and the real signal in
// `code`/`syscall`; an empty string is falsy and would slip past the
// `if (res.error)` guards downstream, leaving a null status with no explanation
// (the bare "status 0" / "no status line" case this whole path exists to avoid).
function describeTransportError(err: unknown): string {
  const e = err as { message?: string; code?: string; syscall?: string };
  const parts = [
    e?.message?.trim(),
    e?.code ? `code=${e.code}` : "",
    e?.syscall ? `syscall=${e.syscall}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "transport error with no detail";
}

// Per-hop timeout for every admin probe: connectivity test, model discovery,
// and per-model test. A flat 30s, NOT the provider's requestTimeoutMs.
//
// Deliberately fixed rather than inherited: a probe is an interactive admin
// action with its own latency budget, and inheriting made the wait unpredictable
// (a provider configured with a 600s request timeout would hang the Test button
// for ten minutes). Distant regional endpoints regularly need 10s+ just for the
// TCP+TLS handshake, so 30s is the headroom that covers them without leaving an
// operator staring at a spinner.
const PROBE_TIMEOUT_MS = 30_000;

// One HTTP round-trip with the provider's outbound proxy + TLS-verify + a
// bounded timeout. Returns the raw status/body (never throws — a transport
// error resolves with status:null + error). No redirect handling — see rawRequest,
// which wraps this with redirect-following; every other call site should use
// that, not this, so a 301/302/307/308 from a reverse proxy or an http->https
// canonicalization doesn't surface as a bare non-2xx failure.
function rawRequestOnce(
  urlStr: string,
  opts: {
    method?: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    tlsVerify: boolean;
    proxy?: string | null;
    timeoutMs?: number;
  },
): Promise<{
  status: number | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  ms: number;
  error?: string;
}> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch (err) {
    return Promise.resolve({
      status: null,
      headers: {},
      body: "",
      ms: 0,
      error: `bad url: ${(err as Error).message}`,
    });
  }
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  let proxyAgent: ReturnType<typeof dispatchAgent>;
  try {
    proxyAgent = dispatchAgent(opts.proxy, isHttps);
  } catch (err) {
    return Promise.resolve({
      status: null,
      headers: {},
      body: "",
      ms: 0,
      error: `bad proxy: ${(err as Error).message}`,
    });
  }
  const start = Date.now();
  return new Promise((resolve) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        method: opts.method ?? "GET",
        path: url.pathname + url.search,
        headers: opts.headers,
        rejectUnauthorized: opts.tlsVerify,
        // Always an explicit agent: the proxy one when configured, otherwise
        // the IPv4-first direct agent (see dispatchAgent/directAgent — both
        // the lookup order and autoSelectFamily only take effect at agent level).
        agent: proxyAgent,
      },
      (upRes) => {
        const chunks: Buffer[] = [];
        upRes.on("data", (c) => chunks.push(c as Buffer));
        upRes.on("end", () =>
          resolve({
            // statusCode is always set on a completed response; the fallback
            // only fires if the socket died between headers and 'end'. Carry an
            // explicit error so no caller can coerce this into a bare status 0.
            status: upRes.statusCode ?? null,
            headers: upRes.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            ms: Date.now() - start,
            ...(upRes.statusCode
              ? {}
              : { error: "upstream closed before sending a status line" }),
          }),
        );
        // A connection dropped mid-body emits 'error' on the RESPONSE, not the
        // request. Without this the promise never settles (the probe hangs until
        // the timeout) and Node treats it as an unhandled stream error.
        upRes.on("error", (err) =>
          resolve({
            status: null,
            headers: upRes.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            ms: Date.now() - start,
            error: `response stream error: ${describeTransportError(err)}`,
          }),
        );
      },
    );
    req.on("error", (err) =>
      resolve({
        status: null,
        headers: {},
        body: "",
        ms: Date.now() - start,
        // Node socket/TLS errors sometimes carry an EMPTY message while the
        // useful part is in .code/.syscall. An empty string here is falsy, so
        // it would slip past every `if (res.error)` guard downstream and
        // resurface as an unexplained null status — always synthesize
        // something actionable.
        error: describeTransportError(err),
      }),
    );
    const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`probe timeout after ${timeoutMs}ms`)),
    );
    req.end(opts.body);
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// Transport failures worth a second attempt: the connection never produced an
// HTTP response, and the cause is the kind that clears on its own. A slow or
// congested route (some regional endpoints intermittently take 10s+ just to
// finish the TCP+TLS handshake) shows up here as a timeout or reset, and one
// retry turns an operator-visible "Failed" into a normal result. Deliberately
// NOT retried: DNS NXDOMAIN, bad URL/proxy config, cert-verification failures —
// those are deterministic, and retrying only doubles the wait before the same
// answer.
const RETRYABLE_TRANSPORT = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "socket hang up",
  "response stream error",
  "before sending a status line",
];
// Deliberately NOT retried: "probe timeout". These failures are all fast, so a
// second attempt is nearly free — but the timeout is 30s, and retrying it would
// mean a 60s wait behind an interactive Test button. If 30s wasn't enough, the
// answer is a real diagnosis, not doubling the spinner.

function isRetryableTransportError(error: string | undefined): boolean {
  if (!error) return false;
  return RETRYABLE_TRANSPORT.some((needle) => error.includes(needle));
}

// How a probe reports a transport problem to the operator. Wired from the route
// layer (which owns the Logger); omitted by tests and other callers.
export interface ProbeLogCtx {
  logger?: Logger;
  /** Provider id (saved) or a label like "wizard" for a pre-create probe. */
  providerId?: string;
}

// Low-level HTTP request with the provider's outbound proxy + TLS-verify, a
// bounded per-hop timeout, AND redirect-following (up to MAX_REDIRECTS hops) —
// the transport every connectivity test, model-list fetch, and adapter
// keyUsage()/testModel() query goes through. A reverse proxy that 301s
// http->https, or a usage endpoint that redirects a trailing-slash mismatch,
// resolves transparently instead of surfacing as a bare "status 301" failure.
//
// Redirect semantics mirror a browser/fetch client:
//   - 301/302/303 -> GET on the Location, body dropped (303 always does this
//     per spec; 301/302 do it too since that's what virtually every server
//     expects a client to do, even though the spec technically allows method
//     preservation there).
//   - 307/308 -> same method + body replayed against the Location (the whole
//     point of these two codes is "don't change the request").
// Relative Location headers resolve against the current URL. A malformed or
// missing Location, or exceeding MAX_REDIRECTS, returns the redirect response
// itself rather than throwing — the caller sees a real status to reason about.
async function rawRequest(
  urlStr: string,
  opts: {
    method?: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    tlsVerify: boolean;
    proxy?: string | null;
    timeoutMs?: number;
    /** Extra attempts after a retryable transport failure (default 1). */
    retries?: number;
    log?: ProbeLogCtx;
  },
): Promise<{
  status: number | null;
  body: string;
  ms: number;
  error?: string;
}> {
  const attempts = Math.max(1, (opts.retries ?? 1) + 1);
  const overallStart = Date.now();
  let res = await followRedirects(urlStr, opts, 0, Date.now());

  for (let attempt = 2; attempt <= attempts; attempt++) {
    if (!isRetryableTransportError(res.error)) break;
    opts.log?.logger?.warn("provider_probe_retry", {
      provider: opts.log.providerId,
      url: urlStr,
      attempt: `${attempt - 1}/${attempts}`,
      ms: res.ms,
      err: res.error,
    });
    // Short fixed pause — the failures this retries are transient-by-nature
    // (handshake stalls, resets), not rate limits, so there's nothing to back
    // off from; a long sleep would just stall an interactive admin action.
    await new Promise((r) => setTimeout(r, 400));
    res = await followRedirects(urlStr, opts, 0, Date.now());
  }

  // A probe that never got a status line is the case that used to surface in
  // the UI as a bare, unexplained "status 0". Always log it with the real cause.
  if (res.status === null)
    opts.log?.logger?.warn("provider_probe_transport_failed", {
      provider: opts.log.providerId,
      url: urlStr,
      attempts,
      ms: Date.now() - overallStart,
      err: res.error ?? "no status line and no transport error",
    });

  return res;
}

async function followRedirects(
  urlStr: string,
  opts: {
    method?: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    tlsVerify: boolean;
    proxy?: string | null;
    timeoutMs?: number;
  },
  hop: number,
  overallStart: number,
): Promise<{
  status: number | null;
  body: string;
  ms: number;
  error?: string;
}> {
  const res = await rawRequestOnce(urlStr, opts);
  if (res.error || res.status === null) {
    return { status: res.status, body: res.body, ms: res.ms, error: res.error };
  }
  if (!REDIRECT_STATUSES.has(res.status) || hop >= MAX_REDIRECTS) {
    return {
      status: res.status,
      body: res.body,
      ms: Date.now() - overallStart,
    };
  }
  const location = res.headers.location;
  const target = Array.isArray(location) ? location[0] : location;
  if (!target) {
    // A redirect status with no (or an unusable) Location — nothing to
    // follow; hand back the redirect response itself.
    return {
      status: res.status,
      body: res.body,
      ms: Date.now() - overallStart,
    };
  }
  let nextUrl: string;
  try {
    nextUrl = new URL(target, urlStr).toString();
  } catch {
    return {
      status: res.status,
      body: res.body,
      ms: Date.now() - overallStart,
    };
  }
  // 303 always downgrades to GET; 301/302 downgrade a non-GET (matches every
  // real client's behavior, even though the RFC nominally allows preserving
  // the method there). 307/308 always preserve method + body.
  const preserveMethod = res.status === 307 || res.status === 308;
  const nextOpts = preserveMethod
    ? opts
    : { ...opts, method: "GET" as const, body: undefined };
  return followRedirects(nextUrl, nextOpts, hop + 1, overallStart);
}

// GET-only convenience over rawRequest — the shape every existing GET call
// site (model list, connectivity test) already expects.
function rawGet(
  urlStr: string,
  opts: {
    headers: Record<string, string>;
    tlsVerify: boolean;
    proxy?: string | null;
    timeoutMs?: number;
    retries?: number;
    log?: ProbeLogCtx;
  },
): ReturnType<typeof rawRequest> {
  return rawRequest(urlStr, { ...opts, method: "GET" });
}

// A ModelListTransport backed by rawGet, so fetchModelList honors the provider's
// proxy + tlsVerify (global fetch can do neither SOCKS proxies nor per-request
// rejectUnauthorized). A transport-level error becomes a throw the caller surfaces.
function modelsTransport(
  p: ProviderLike,
  log?: ProbeLogCtx,
): ModelListTransport {
  return async (urlStr, init) => {
    const res = await rawGet(urlStr, {
      headers: init.headers,
      tlsVerify: p.tlsVerify,
      proxy: p.proxy,
      // Flat PROBE_TIMEOUT_MS (see rawRequestOnce) — deliberately NOT the
      // provider's requestTimeoutMs, which can be minutes long.
      log,
    });
    if (res.error) throw new Error(res.error);
    // No status line: throw rather than let `?? 0` manufacture a fake "status 0"
    // the operator can't act on. Name the URL — the usual cause is a request
    // that never reached a route, and the path is the thing worth checking.
    if (res.status === null)
      throw new Error(
        `no response from upstream (no status line) for ${urlStr} after ${res.ms}ms`,
      );
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      // No status line from rawGet — surface a short body snippet so a non-2xx
      // error is diagnostic (e.g. the upstream's own message) instead of blank.
      statusText: res.body.slice(0, 120).replace(/\s+/g, " ").trim(),
      json: async () => {
        try {
          return JSON.parse(res.body);
        } catch {
          throw new Error("model list response was not valid JSON");
        }
      },
    };
  };
}

// GET {origin}{basePath}{modelsPath} for a connectivity test — reuses rawGet so
// the test and model discovery share one transport. `keyOverride` see
// modelsRequestHeaders.
function probeModels(
  p: ProviderLike,
  keyOverride?: string,
  log?: ProbeLogCtx,
): Promise<{
  status: number | null;
  body: string;
  ms: number;
  error?: string;
}> {
  return rawGet(modelsUrl(p), {
    headers: {
      accept: "application/json",
      ...modelsRequestHeaders(p, keyOverride),
    },
    tlsVerify: p.tlsVerify,
    proxy: p.proxy,
    // Flat PROBE_TIMEOUT_MS — see rawRequestOnce.
    log,
  });
}

// A ModelsCtx built from a saved/ad-hoc provider's config: the URL parts + a
// resolve() helper (so a bespoke adapter builds URLs without `new URL()`), the
// proxy/TLS transport, and the dialect to fetch in.
function makeModelsCtx(
  p: ProviderLike,
  format: ModelsFormat,
  apiKeyOverride?: string | null,
  log?: ProbeLogCtx,
): Omit<ModelsCtx, "provider"> {
  const basePath = p.basePath || "";
  const modelsPath = p.modelsPath || "/v1/models";
  const resolve: ResolveUrl = (target) =>
    composeUrl(
      p.baseUrl,
      basePath,
      typeof target === "string" ? target : modelsPath,
    );
  const apiKey =
    apiKeyOverride !== undefined ? apiKeyOverride : (p.apiKeys[0] ?? null);
  return {
    baseUrl: p.baseUrl,
    basePath,
    modelsPath,
    resolve,
    url: resolve(),
    headers: modelsRequestHeaders(p, apiKey ?? undefined),
    apiKey,
    format,
    transport: modelsTransport(p, log),
  };
}

// Saved-provider model discovery: goes through the adapter's fetchModels() seam
// so a bespoke override (custom URL/auth/rich hand-built list) is honored, with
// the proxy/TLS-aware transport and the ADAPTER's own dialect (nativeFormat).
// Returns the universal UpstreamModel[].
export async function fetchProviderModels(
  p: Provider,
  db: DB,
  logger?: Logger,
): Promise<UpstreamModel[]> {
  const adapter = adapterForProvider(p);
  const keys = listEnabledCredentials(db, p.id);
  const pl = providerLikeFrom(p, keys);
  return adapter.fetchModels({
    provider: p,
    ...makeModelsCtx(pl, adapter.nativeFormat, undefined, {
      logger,
      providerId: p.id,
    }),
  });
}

// An AdapterRequest backed by rawRequest, so ctx.request() (TestModelCtx AND
// UsageCtx both use this same shape) honors the provider's proxy + tlsVerify
// like every other outbound admin probe (fetchModels, the connectivity test).
// A transport-level error becomes a throw — the caller's catch turns it into a
// clean ok:false/status:null result (testModel) or an "unavailable" key
// (keyUsage).
function adapterRequestTransport(
  p: Provider,
  log?: ProbeLogCtx,
): AdapterRequest {
  return async (urlStr, init) => {
    const res = await rawRequest(urlStr, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      tlsVerify: p.tlsVerify,
      proxy: p.proxy,
      // Flat PROBE_TIMEOUT_MS — see rawRequestOnce.
      log: log ?? { providerId: p.id },
    });
    if (res.error) throw new Error(res.error);
    // Same reasoning as modelsTransport: a null status must surface as a real
    // error naming the URL, never as a bare "status 0" in the UI.
    if (res.status === null)
      throw new Error(
        `no response from upstream (no status line) for ${urlStr} after ${res.ms}ms`,
      );
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      ms: res.ms,
      text: res.body,
      json: () => JSON.parse(res.body),
    };
  };
}

// A TestModelCtx built from a saved provider's config. Deliberately does NOT
// resolve any endpoint kind/path here — `resolve()` only composes origin +
// basePath (+ an explicit kind's path when the ADAPTER'S OWN testModel()
// override asks for one via resolve(WireKind.X)). Which kind to test with is
// adapter-specific knowledge (its native format, its endpoints); the generic
// route handler must never guess it.
function makeTestModelCtx(
  p: Provider,
  apiKey: string | null,
): Omit<TestModelCtx, "provider" | "model"> {
  const basePath = p.basePath || "";
  const resolve: ResolveUrl = (target) =>
    composeUrl(
      p.baseUrl,
      basePath,
      target === undefined
        ? ""
        : target === "chat" || target === "messages" || target === "responses"
          ? endpointPathFor(p, target)
          : target,
    );
  const pl = providerLikeFrom(p, apiKey ? [apiKey] : []);
  return {
    baseUrl: p.baseUrl,
    basePath,
    resolve,
    url: resolve(),
    headers: modelsRequestHeaders(pl, apiKey ?? undefined),
    apiKey,
    request: adapterRequestTransport(p),
  };
}

// Probe one imported model via the adapter's testModel() seam (see
// ProviderAdapter.testModel — a dummy stub until an adapter overrides it).
// `db`/`logger` are optional so tests/other callers can omit them (no
// tracing); the route passes both so probeEndpoint's per-stage XFORM trace
// fires exactly when `settings.debugLogging` is on, same as a real request.
// `ownTransforms` (the imported ProviderModel row's own transform config, when
// the caller has one in hand) lets probeEndpoint() compose the exact same
// full stack (builtin -> family -> adapter -> model) a live request to this
// upstream id would run — omit it to see just the provider/family/adapter
// base every model on this provider starts from.
export async function testProviderModel(
  p: Provider,
  upstreamId: string,
  db?: DB,
  logger?: Logger,
  ownTransforms?: ModelTransformConfig[],
): Promise<TestModelResult> {
  const adapter = adapterForProvider(p);
  const keys = db ? listEnabledCredentials(db, p.id) : [];
  return adapter.testModel({
    provider: p,
    model: upstreamId,
    ...makeTestModelCtx(p, keys[0] ?? null),
    logStage: makeLogStage(db, logger, p.id),
    ownTransforms,
  });
}

// Build a logStage callback for a debug-traced probe — undefined (no tracing,
// zero cost) unless both a db (to read settings.debugLogging) and logger are
// supplied AND the setting is on. Mirrors engine.ts's stageApplyLogger/onStage
// gating, just outside the request-scoped ForwardContext this module doesn't
// have. A fresh shortId() per call groups one probe's stages under one reqId,
// same as a live request's per-attempt trace. Exported for direct unit
// testing (the gating logic, independent of any specific adapter's
// testModel() actually invoking it).
export function makeLogStage(
  db: DB | undefined,
  logger: Logger | undefined,
  providerId: string,
): TestModelCtx["logStage"] {
  if (!db || !logger) return undefined;
  if (getSettings(db).debugLogging !== true) return undefined;
  const reqId = shortId();
  return (dir, name, changed) =>
    logger.transform(dir, name, {
      provider: providerId,
      reqId,
      ...(changed !== undefined ? { changed } : {}),
    });
}

// The same URL/request primitives as makeTestModelCtx, minus anything wire-
// schema-specific — a usage report is a provider-specific endpoint (its own
// arbitrary response shape), not a chat/messages/responses completion, so
// `resolve` has no WireKind branch (ResolvePath, not ResolveUrl).
export function makeUsageCtx(
  p: Provider,
): Pick<UsageCtx, "baseUrl" | "basePath" | "resolve" | "request"> {
  const basePath = p.basePath || "";
  const resolve: ResolvePath = (target) =>
    composeUrl(p.baseUrl, basePath, target ?? "");
  return {
    baseUrl: p.baseUrl,
    basePath,
    resolve,
    request: adapterRequestTransport(p),
  };
}

// Ad-hoc (pre-create wizard) model discovery from a ProviderLike that has no saved
// row/adapter yet, so there's no known wire dialect to trust. The wizard no
// longer asks the caller to declare one up front, so probe the richer
// Anthropic dialect first (display name, context window, max output tokens,
// and capabilities all ride along in that response) and fall back to OpenAI's
// bare id-list shape if the anthropic-flavored request fails outright — a
// non-Anthropic upstream will typically 404/400 on the anthropic-version
// header or the response won't parse as the Anthropic shape.
export async function fetchUpstreamModels(
  p: ProviderLike,
  logger?: Logger,
): Promise<UpstreamModel[]> {
  const tryFormat = async (format: ModelsFormat) => {
    const ctx = makeModelsCtx(p, format, undefined, {
      logger,
      providerId: "wizard",
    });
    const result = await fetchModelList({
      url: ctx.url,
      headers: ctx.headers,
      format: ctx.format,
      transport: ctx.transport,
    });
    return normalizeModels(result);
  };
  if (p.format === "openai") return tryFormat("openai");
  if (p.format === "anthropic") return tryFormat("anthropic");
  try {
    return await tryFormat("anthropic");
  } catch {
    return tryFormat("openai");
  }
}

// `keyUsed` is the RAW key this attempt sends (defaults to apiKeys[0] when the
// caller doesn't pick one via the live rotation/health state — see
// GatewayRouter.pickKeyForTest) — masked here into `keyMask` so the raw value
// never reaches the response. `ProviderLike` carries no id, so a keyless probe
// (the pre-create wizard path with no apiKeys yet) reports no keyMask.
//
// Ad-hoc ONLY: this is the pre-create wizard's connectivity probe
// (`POST /provider-catalog/test`), for a `ProviderLike` config that has no id
// and therefore no adapter to resolve — there's no catalog entry to ask "does
// this provider customize its connectivity check?" yet, so this is always the
// plain model-list GET. A SAVED provider goes through `testSavedProvider`
// below instead, which resolves the adapter and honors a `testProvider()`
// override (see example-custom.ts).
export async function testProviderAdhoc(
  p: ProviderLike,
  keyUsed?: string,
  logger?: Logger,
): Promise<{
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  sample?: string;
  keyMask?: string;
}> {
  const key = keyUsed ?? p.apiKeys[0];
  const res = await probeModels(p, key, { logger, providerId: "wizard" });
  return {
    ok: !!res.status && res.status >= 200 && res.status < 400,
    status: res.status,
    ms: res.ms,
    error: res.error,
    sample: res.body.slice(0, 240) || undefined,
    keyMask: key ? maskProviderKey(key) : undefined,
  };
}

// A TestProviderCtx built from a saved provider's config. `resolve()` targets
// the model-list endpoint by default (the same universally-available target
// the base ProviderAdapter.testProvider() default probes) — same WireKind
// disambiguation as makeTestModelCtx's resolve(), so a bespoke testProvider()
// override can still resolve a specific wire kind's path (e.g. to send a
// minimal probe at /v1/chat/completions instead) without ever touching `new
// URL()`.
function makeTestProviderCtx(
  p: Provider,
  keys: string[],
  keyOverride?: string,
  logger?: Logger,
): Omit<TestProviderCtx, "provider"> {
  const basePath = p.basePath || "";
  const resolve: ResolveUrl = (target) =>
    composeUrl(
      p.baseUrl,
      basePath,
      target === undefined
        ? p.modelsPath || "/v1/models"
        : target === "chat" || target === "messages" || target === "responses"
          ? endpointPathFor(p, target)
          : target,
    );
  const apiKey = keyOverride ?? keys[0] ?? null;
  const pl = providerLikeFrom(p, apiKey ? [apiKey] : []);
  return {
    baseUrl: p.baseUrl,
    basePath,
    resolve,
    url: resolve(),
    headers: modelsRequestHeaders(pl, keyOverride),
    apiKey,
    request: adapterRequestTransport(p, { logger, providerId: p.id }),
  };
}

// SAVED-provider connectivity test — resolves the adapter and calls its
// testProvider() seam (default: GET the model-list endpoint; a bespoke
// adapter can override — see example-custom.ts). Powers `POST
// /providers/:id/test`, both the plain "Test connection" button (no
// `keyUsed`, so the live rotation/health pick applies) and the per-key Test
// button in the Keys tab (`keyUsed` pins one exact key, bypassing rotation).
// The raw key never leaves this function — `keyMask` is computed here, from
// the SAME key the adapter was actually handed, so the UI always reports
// which key a result belongs to regardless of which adapter answered.
export async function testSavedProvider(
  p: Provider,
  db: DB,
  keyUsed?: string,
  logger?: Logger,
): Promise<{
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  sample?: string;
  keyMask?: string;
}> {
  const adapter = adapterForProvider(p);
  const keys = listEnabledCredentials(db, p.id);
  const ctx = makeTestProviderCtx(p, keys, keyUsed, logger);
  const result = await adapter.testProvider({ provider: p, ...ctx });
  return {
    ...result,
    keyMask: ctx.apiKey ? maskProviderKey(ctx.apiKey) : undefined,
  };
}
