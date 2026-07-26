// Moonshot: kimi-* models are pinned to temperature 1.
//
// Driven through the REAL buildTransformPlan/applyBodyTransforms pair that
// engine.ts's buildRoute uses, rather than calling the transform's apply()
// directly — so the test also covers the stage actually being wired into the
// adapter's plan, not just behaving correctly once reached.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdapter } from "./index";
import {
  buildTransformPlan,
  applyBodyTransforms,
  type Json,
} from "../formats/pipeline";
import { WireKind, type Provider } from "../types";

function runFor(
  catalogId: string,
  upstreamModel: string,
  body: Json,
  kind: WireKind = WireKind.Chat,
): Json {
  const adapter = getAdapter(catalogId)!;
  const provider = { id: catalogId, catalogId, name: catalogId } as Provider;
  const plan = buildTransformPlan(
    kind,
    { forwardPath: "/v1/chat/completions", providerFmt: kind },
    adapter.transforms(provider),
  );
  return applyBodyTransforms(plan.request, { ...body }, {
    provider,
    clientFmt: kind,
    providerFmt: kind,
    upstreamModel,
  } as never) as Json;
}

const run = (m: string, b: Json, k?: WireKind) => runFor("moonshot", m, b, k);

test("a kimi-* model is forced to temperature 1, overriding the client's value", () => {
  assert.equal(
    run("kimi-k2.5", { model: "kimi-k2.5", temperature: 0.2 }).temperature,
    1,
  );
  assert.equal(
    run("kimi-latest", { model: "kimi-latest", temperature: 2 }).temperature,
    1,
  );
});

test("a kimi-* model with no temperature gets one set", () => {
  assert.equal(
    run("kimi-k2-thinking", { model: "kimi-k2-thinking" }).temperature,
    1,
  );
});

test("the prefix match is case-insensitive", () => {
  assert.equal(
    run("KIMI-K2", { model: "KIMI-K2", temperature: 0 }).temperature,
    1,
  );
});

test("a non-kimi model on the same provider is untouched", () => {
  assert.equal(
    run("moonshot-v1-8k", { model: "moonshot-v1-8k", temperature: 0.3 })
      .temperature,
    0.3,
  );
});

test("the match requires the trailing dash, and must be a PREFIX", () => {
  // "kimi" alone and "akimi-x" must not match — otherwise the rule would creep
  // onto models it was never meant to cover.
  assert.equal(
    run("kimi", { model: "kimi", temperature: 0.3 }).temperature,
    0.3,
  );
  assert.equal(
    run("akimi-x", { model: "akimi-x", temperature: 0.3 }).temperature,
    0.3,
  );
});

test("it applies on the messages (Anthropic) wire kind too, not just chat", () => {
  const out = run(
    "kimi-k2.5",
    { model: "kimi-k2.5", temperature: 0.1 },
    WireKind.Messages,
  );
  assert.equal(out.temperature, 1);
});

test("the UPSTREAM model id decides, not the exposed alias in the body", () => {
  // An alias can be named anything; keying off body.model would miss real
  // kimi-* hops routed under a differently-named alias.
  const out = run("kimi-k2.5", {
    model: "some-exposed-alias",
    temperature: 0.4,
  });
  assert.equal(out.temperature, 1);
});

test("other providers are unaffected, even for a kimi-named model", () => {
  // e.g. DashScope's plan legitimately serves kimi-k2.5; only Moonshot pins it.
  for (const id of ["qwencloud-cn", "openai", "dashscope-coding"]) {
    const out = runFor(id, "kimi-k2.5", {
      model: "kimi-k2.5",
      temperature: 0.3,
    });
    assert.equal(out.temperature, 0.3, `${id} should not be affected`);
  }
});
