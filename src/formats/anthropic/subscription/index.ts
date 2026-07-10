import type { RequestTransform, TransformCtx, Json } from "../../pipeline";

const SUBSCRIPTION_GROUP = "anthropic-subscription-hooks";
export const subscriptionActive = (ctx: TransformCtx): boolean =>
  ctx.provider?.catalogId === "anthropic-subscription";

function gated(
  name: string,
  label: string,
  blurb: string,
  body: (b: Json, ctx: TransformCtx) => Json,
): RequestTransform {
  return {
    name,
    label,
    blurb,
    group: SUBSCRIPTION_GROUP,
    apply: (b, ctx) => (subscriptionActive(ctx) ? body(b, ctx) : b),
  };
}

const identity = (b: Json): Json => b;

export const classifierScrubStub = gated(
  "anthropic-subscription:classifier-scrub",
  "Client-fingerprint scrub",
  "Erase third-party client fingerprints from system[]/messages[].",
  identity,
);

export const toolNormalizeStub = gated(
  "anthropic-subscription:tool-normalize",
  "Tool-name normalization",
  "Rename third-party tool names to Claude Code's PascalCase and inject decoy tools.",
  identity,
);

export const oauthBillingStub = gated(
  "anthropic-subscription:oauth-billing",
  "OAuth billing/attestation",
  "Rebuild system[] into Claude Code's ordering and inject valid billing/attestation headers.",
  identity,
);

export const subscriptionRequestStack: RequestTransform[] = [
  classifierScrubStub,
  toolNormalizeStub,
  oauthBillingStub,
];
