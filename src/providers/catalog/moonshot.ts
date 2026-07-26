import {
  OpenAICompatibleAdapter,
  type BuildCtx,
  type BuiltRequest,
  type UsageCtx,
  type KeyUsageResult,
} from "../base";
import { WireKind, type Provider } from "../../types";
import type { Json, RequestTransform } from "../../formats/pipeline";
import { OPENAI_DEFAULT_TRANSFORMS } from "./openai";

// Moonshot Kimi (mainland China endpoint).
//
// Inference base URL: https://api.moonshot.cn/v1
// Anthropic-format endpoint: /anthropic (sibling path, NOT under /v1)
// Auth: Authorization: Bearer <api-key>
//
// The international host is https://api.moonshot.ai with the same path layout,
// so switching regions is just an edit of the (editable) base URL field.

// Kimi models are pinned to temperature 1.
//
// Matched on the UPSTREAM model id (ctx.upstreamModel - the id actually sent to
// this provider), not the exposed alias: an alias can be named anything, so
// keying off it would both miss real kimi-* hops and fire on non-Kimi ones.
// Falls back to the body's own `model` for the handful of TransformCtx call
// sites that carry no upstreamModel (unit tests, the SSE-only stream path).
//
// Runs on the request stage, so it applies to every wire kind this provider
// serves - chat and messages alike - and after format conversion, so it sets
// the field on the body actually going upstream.
const forceKimiTemperature: RequestTransform = {
  name: "moonshot-kimi-temperature",
  label: "Kimi temperature = 1",
  blurb:
    "Forces temperature to 1 on kimi-* models, replacing any client-supplied value.",
  apply: (body: Json, ctx): Json => {
    if (!body || typeof body !== "object") return body;
    const model =
      ctx.upstreamModel ??
      (typeof body.model === "string" ? body.model : undefined);
    if (!model?.toLowerCase().startsWith("kimi-")) return body;
    body.temperature = 1;
    return body;
  },
};

// GET {origin}{basePath}/users/me/balance — resolved through ctx.resolve so it
// follows the provider's CONFIGURED base URL. Deliberately not a hardcoded
// constant (the way deepseek.ts pins its host): this provider's base URL is an
// editable field, and both regions serve this path, so hardcoding .cn would
// query the wrong account for anyone pointed at .ai.
const BALANCE_PATH = "/users/me/balance";

// Success envelope:
//   { code: 0, data: { available_balance, voucher_balance, cash_balance },
//     scode: "0x0", status: true }
// Amounts are CNY. `available_balance` is the spendable total; the other two
// break it down into free-voucher vs paid-cash. It can go NEGATIVE when an
// account is in arrears, so nothing here clamps it.
interface BalanceData {
  available_balance?: number;
  voucher_balance?: number;
  cash_balance?: number;
}
interface BalanceResp {
  code?: number;
  data?: BalanceData;
  scode?: string;
  status?: boolean;
  // Failure shape: { error: { message, type } } — same envelope the chat
  // endpoints use.
  error?: { message?: string; type?: string };
}

const CNY = (n: number) => `${n.toFixed(2)} CNY`;

class MoonshotAdapter extends OpenAICompatibleAdapter {
  override requestTransforms(p: Provider): RequestTransform[] {
    return [...super.requestTransforms(p), forceKimiTemperature];
  }

  override supportsKeyUsage(_ctx: UsageCtx): boolean {
    return true;
  }

  // Account balance for one key. No windows — this is a credit balance, not a
  // rate-limit quota, so it reports as a message the way deepseek.ts does
  // rather than fabricating a bar with no real ceiling to divide by.
  override async keyUsage(ctx: UsageCtx): Promise<KeyUsageResult> {
    if (!ctx.enabled) {
      return {
        windows: [],
        unavailable: true,
        message: "Key disabled - usage not queried.",
      };
    }

    let res;
    try {
      res = await ctx.request(ctx.resolve(BALANCE_PATH), {
        method: "GET",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          accept: "application/json",
        },
        signal: ctx.signal,
      });
    } catch (err) {
      return {
        windows: [],
        unavailable: true,
        message: `Balance query failed: ${(err as Error).message}`,
      };
    }

    // Parse before branching on status: the failure body carries the upstream's
    // own message ("Invalid Authentication"), which is far more useful to an
    // operator than a bare "HTTP 401".
    let data: BalanceResp | null = null;
    try {
      data = res.json() as BalanceResp;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const upstream = data?.error?.message;
      return {
        windows: [],
        unavailable: true,
        message: upstream
          ? `Balance endpoint: ${upstream} (HTTP ${res.status})`
          : `Balance endpoint returned HTTP ${res.status}`,
      };
    }

    if (!data) {
      return {
        windows: [],
        unavailable: true,
        message: "Balance endpoint returned a non-JSON response.",
      };
    }

    // A 200 can still carry a logical failure (status:false / non-zero code).
    if (data.status === false || (data.code !== undefined && data.code !== 0)) {
      return {
        windows: [],
        unavailable: true,
        message:
          data.error?.message ??
          `Balance endpoint reported code ${data.code ?? "?"}.`,
      };
    }

    const available = data.data?.available_balance;
    if (typeof available !== "number" || !Number.isFinite(available)) {
      return {
        windows: [],
        unavailable: true,
        message: "Could not parse balance data.",
      };
    }

    // Show the voucher/cash split only when a voucher is actually present —
    // for a cash-only account it would just be noise.
    const voucher = data.data?.voucher_balance;
    const cash = data.data?.cash_balance;
    const parts = [`${CNY(available)} remaining`];
    if (typeof voucher === "number" && voucher > 0)
      parts.push(
        `voucher ${CNY(voucher)}${typeof cash === "number" ? ` · cash ${CNY(cash)}` : ""}`,
      );

    const line = parts.join(" · ");
    return {
      windows: [],
      // Mirrors deepseek's "insufficient for API calls" flag: a zero or negative
      // balance means requests will fail, which is worth saying outright.
      message: available > 0 ? line : `${line} - insufficient for API calls`,
    };
  }

  // The Anthropic-format endpoint is a sibling of /v1 - <origin>/anthropic,
  // not <origin>/v1/anthropic. ctx.baseUrl is just the origin (the /v1 prefix
  // is carried in ctx.basePath), so append directly to it.
  //
  // `/anthropic` is the ANTHROPIC_BASE_URL Moonshot documents, i.e. a BASE that
  // the client appends the Messages path to - the bare path is not itself an
  // endpoint. Verified against the live host: POST /anthropic -> 404, POST
  // /anthropic/v1/messages -> 401 (auth reached), and a nonsense path -> 404,
  // so this host routes before it authenticates and that 404 is a real miss.
  override messages(ctx: BuildCtx): BuiltRequest {
    const url = ctx.baseUrl.replace(/\/+$/, "") + "/anthropic/v1/messages";
    return { url, headers: ctx.headers, body: ctx.body };
  }
}

export const moonshot = new MoonshotAdapter({
  id: "moonshot",
  label: "Moonshot Kimi",
  blurb:
    "Moonshot AI Kimi - OpenAI-compatible and Anthropic-compatible endpoints.",
  brand: "kimi",
  docsUrl: "https://platform.moonshot.cn/docs",
  defaults: {
    baseUrl: "https://api.moonshot.cn",
    basePath: "/v1",
    modelsPath: "/models",
    endpoints: [WireKind.Chat, WireKind.Messages],
    authScheme: "bearer",
    nativeConversion: false,
  },
  fields: [
    {
      key: "name",
      label: "Name",
      placeholder: "moonshot",
      required: true,
    },
    {
      key: "apiKeys",
      label: "API key",
      placeholder: "sk-…",
      required: true,
      hint: "One per line - rotated round-robin.",
    },
    {
      key: "baseUrl",
      label: "Base URL",
      editable: true,
      hint: "Default: https://api.moonshot.cn - use https://api.moonshot.ai for the international endpoint.",
    },
  ],
  quirks: {
    defaultTransforms: OPENAI_DEFAULT_TRANSFORMS,
  },
});
