import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clineFingerprintHeaders,
  clineRetryDelayMs,
  extractClineRetryTime,
  formatClineAccessToken,
  isClineFreeLimitError,
  parseClineFreeModels,
  STATIC_CLINE_FREE_MODELS,
} from "./clinefree";

test("Cline access tokens are workos-prefixed exactly once", () => {
  assert.equal(formatClineAccessToken("abc"), "workos:abc");
  assert.equal(formatClineAccessToken("workos:abc"), "workos:abc");
  assert.equal(formatClineAccessToken("WORKOS:abc"), "WORKOS:abc");
});

test("Cline fingerprint includes fixed identity and unique task ids", () => {
  const a = clineFingerprintHeaders("abc");
  const b = clineFingerprintHeaders("abc");
  assert.equal(a.authorization, "Bearer workos:abc");
  assert.equal(a["x-client-type"], "cline-cli");
  assert.equal(a["x-platform"], "cli");
  assert.equal(a["http-referer"], "https://cline.bot");
  assert.notEqual(a["x-task-id"], b["x-task-id"]);
});

test("Cline free model parser preserves only reported metadata", () => {
  const models = parseClineFreeModels({
    free: [
      { id: "poolside/model:free", name: "Model" },
      {
        id: "reported/model",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
      },
    ],
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "poolside/model:free");
  assert.equal(models[0].displayName, "Model");
  assert.equal(models[0].contextWindow, undefined);
  assert.equal(models[0].maxOutputTokens, undefined);
  assert.equal(models[1].contextWindow, 64_000);
  assert.equal(models[1].maxOutputTokens, 4_096);
});

test("Cline static fallback models do not invent model limits", () => {
  for (const model of STATIC_CLINE_FREE_MODELS) {
    assert.equal(model.contextWindow, undefined);
    assert.equal(model.maxOutputTokens, undefined);
  }
});

test("Cline free-limit helpers parse retry text", () => {
  const body = "Free limit reached on model. Try again in 4 minutes.";
  assert.equal(isClineFreeLimitError(body), true);
  assert.equal(extractClineRetryTime(body), "4 minutes");
  assert.equal(clineRetryDelayMs(body), 240_000);
});
