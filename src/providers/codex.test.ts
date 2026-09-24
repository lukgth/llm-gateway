import { test } from "node:test";
import os from "os";
import assert from "node:assert/strict";
import {
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_REQWEST_VERSION,
  codexIdentityHeaders,
  codexOsSegment,
  codexRetryDelayMs,
  codexUserAgent,
  isCodexUsageLimitError,
  parseCodexModels,
} from "./codex";

test("Codex user agent pins the CLI and reqwest identity", () => {
  const expectedOsSegment = `${
    process.platform === "darwin"
      ? "Mac OS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform
  } ${os.release()}; ${os.arch() === "x64" ? "x86_64" : os.arch()}`;
  const userAgent = codexUserAgent();

  assert.equal(
    userAgent,
    `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (${expectedOsSegment}) reqwest/0.12.28`,
  );
  assert.equal(
    userAgent,
    `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION} (${expectedOsSegment}) reqwest/${CODEX_REQWEST_VERSION}`,
  );
  assert.equal(CODEX_REQWEST_VERSION, "0.12.28");
  assert.match(userAgent, /^\S+\/\S+ \([^)]+; [^)]+\) reqwest\/\S+$/);
});

test("Codex identity headers are exactly the three wire identity headers", () => {
  const headers = codexIdentityHeaders();

  assert.deepEqual(headers, {
    originator: CODEX_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    "user-agent": codexUserAgent(),
  });
  assert.deepEqual(Object.keys(headers).sort(), [
    "originator",
    "user-agent",
    "version",
  ]);
});

test("Codex OS segment maps known platforms and preserves unknown values", () => {
  assert.equal(codexOsSegment("darwin", "24.0", "x64"), "Mac OS 24.0; x86_64");
  assert.equal(codexOsSegment("win32", "10.0", "arm64"), "Windows 10.0; arm64");
  assert.equal(codexOsSegment("linux", "6.8", "s390x"), "Linux 6.8; s390x");
  assert.equal(
    codexOsSegment("freebsd", "14.1", "ppc64"),
    "FreeBSD 14.1; powerpc64",
  );
  assert.equal(codexOsSegment("plan9", "4.0", "mips"), "plan9 4.0; mips");
});

test("Codex model parsing keeps only visible API models and skips malformed entries", () => {
  const models = parseCodexModels({
    models: [
      { slug: "visible", display_name: "Visible", visibility: "list" },
      { slug: "implicit-visible", display_name: "Implicit" },
      { slug: "", display_name: "Empty" },
      { slug: "   ", display_name: "Blank" },
      { slug: "disabled", supported_in_api: false },
      { slug: "hidden", visibility: "hide" },
      { slug: "enabled-explicit", supported_in_api: true },
      null,
      "not-an-object",
      {},
    ],
  });

  assert.deepEqual(
    models.map((model) => model.id),
    ["visible", "implicit-visible", "enabled-explicit"],
  );
  assert.equal(models[0].displayName, "Visible");
  assert.equal(models[1].displayName, "Implicit");
  assert.equal(models[2].displayName, "enabled-explicit");
});

test("Codex model parsing tolerates a non-array models field", () => {
  assert.deepEqual(parseCodexModels({ models: "not-an-array" }), []);
  assert.deepEqual(parseCodexModels(null), []);
});

test("Codex usage-limit helpers detect the body and parse resets_in_seconds", () => {
  const body = JSON.stringify({
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      plan_type: "plus",
      resets_at: 1790503180,
      eligible_promo: null,
      resets_in_seconds: 213420,
    },
  });
  assert.equal(isCodexUsageLimitError(body), true);
  assert.equal(codexRetryDelayMs(body), 213_420_000);
});

test("Codex usage-limit helpers ignore unrelated or malformed bodies", () => {
  assert.equal(
    isCodexUsageLimitError('{"error":{"type":"rate_limited"}}'),
    false,
  );
  assert.equal(codexRetryDelayMs("not json"), undefined);
  assert.equal(codexRetryDelayMs(JSON.stringify({ error: {} })), undefined);
  assert.equal(
    codexRetryDelayMs(JSON.stringify({ error: { resets_in_seconds: -5 } })),
    undefined,
  );
  assert.equal(
    codexRetryDelayMs(JSON.stringify({ error: { resets_in_seconds: "x" } })),
    undefined,
  );
});
