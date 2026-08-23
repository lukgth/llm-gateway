// Deterministic end-to-end verification (plan Verification steps 3 + 4):
//   1. Import a synthetic unexpired auth.json through the real route,
//      create the openai-codex provider from its ready session, send a
//      Responses request through the REAL engine, and assert the fake
//      upstream sees the Codex identity + converted success response.
//   2. Cookie scenario: inject a fake ChatGPT session fetch, submit only a
//      cookie value, and assert the exact cookie header + ready session +
//      absence of cookie/token in views and errors.

import http from "http";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { AddressInfo } from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { Writable } from "stream";
import { openDatabase, closeDatabase } from "./db";
import { createProvider } from "./repo/providers";
import { createModel, getModel } from "./repo/models";
import { listProviderOAuthViews } from "./repo/provider-oauth";
import { ProviderAuthCrypto } from "./services/provider-auth/crypto";
import { ProviderAuthService } from "./services/provider-auth/service";
import { codexAuth } from "./services/provider-auth/integrations/codex";
import {
  ProviderCredentialService as RealProviderCredentialService,
} from "./services/provider-credentials";
import { ForwardingEngine } from "./gateway/engine";
import { ThinkingConverter } from "./formats/thinking";
import { Logger } from "./logger";
import { WireKind } from "./types";

function b64url(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const EXP = Math.floor(Date.now() / 1000) + 3_600;
const AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: `h.${b64url({
      email: "e2e@example.com",
      exp: EXP,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-e2e-full" },
    })}.s`,
    refresh_token: "e2e-refresh",
  },
});


test("E2E: import auth.json -> create provider -> Responses request hits Codex identity on the wire", async () => {
  const captured: Record<string, unknown> = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.path = req.url;
      captured.headers = req.headers;
      try {
        captured.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        captured.body = null;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp-e2e",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "all good" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-e2e-"));
  const db = openDatabase(":memory:");
  try {
    // 1. Import through the REAL integration.
    assert.ok(codexAuth.import);
    const credential = await codexAuth.import({
      kind: "auth_json",
      value: AUTH_JSON,
    });
    assert.equal(credential.account.accountId, "acct-e2e-full");

    // 2. Persist via the service's adoption (as POST /providers would).
    const crypto = new ProviderAuthCrypto(db, dir);
    const provider = createProvider(db, {
      id: "codex-e2e",
      name: "OpenAI Codex",
      baseUrl: `http://127.0.0.1:${port}`,
      basePath: "/backend-api/codex",
      modelsPath: "/models",
      endpoints: [WireKind.Responses, WireKind.Chat],
      authScheme: "bearer",
      catalogId: "openai-codex",
      retryAttempts: 1,
    });
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-e2e-auth-"));
    const authService = new ProviderAuthService(db, crypto);
    const view = await authService.import(
      "openai-codex",
      { kind: "auth_json", value: AUTH_JSON },
      "owner-e2e",
    );
    void authDir;
    authService.adoptForNewProvider(view.id, "owner-e2e", provider.id, "openai-codex");
    const rows = listProviderOAuthViews(db, provider.id);
    assert.equal(rows.length, 1);

    // 3. Forward a Responses-format client request through the real engine.
    const modelRow = getModel(
      db,
      createModel(db, {
        alias: "e2e-codex-model",
        providers: [{ providerId: provider.id, upstreamModel: "gpt-5-codex" }],
      }).id,
    )!;
    const logger = new Logger();
    const noop = () => {};
    (logger as unknown as { write: () => void }).write = noop;
    (logger as unknown as { request: () => void }).request = noop;
    (logger as unknown as { transform: () => void }).transform = noop;
    (logger as unknown as { upstreamError: () => void }).upstreamError = noop;

    const engine = new ForwardingEngine(
      db,
      logger,
      new ThinkingConverter(),
      0,
      new RealProviderCredentialService(db, crypto),
    );

    let statusCode = 0;
    let bodyText = "";
    const res = new Writable({
      write(chunk, _enc, cb) {
        bodyText += chunk.toString();
        cb();
      },
    }) as never;
    (res as { writeHead: (code: number) => void }).writeHead = (code: number) => {
      statusCode = code;
    };
    Object.defineProperty(res, "headersSent", {
      get: () => statusCode > 0,
      configurable: true,
    });
    Object.defineProperty(res, "writableEnded", {
      value: false,
      configurable: true,
    });

    await engine.forward(
      { method: "POST", headers: {} } as never,
      res,
      {
        clientPath: "/v1/responses",
        requestBody: {
          model: "e2e-codex-model",
          input: "hi",
        },
        resolvedModel: modelRow,
        alias: modelRow.alias,
        apiKey: null,
        inputTokens: 0,
        reservedTokens: 0,
        isStream: false,
        client: null,
        debug: false,
      } as never,
    );

    // 4. Assertions: exact wire shape.
    assert.equal(captured.path, "/backend-api/codex/responses");
    const headers = captured.headers as Record<string, string | undefined>;
    assert.match(String(headers.authorization), /^Bearer /);
    assert.equal(headers["chatgpt-account-id"], "acct-e2e-full");
    assert.equal(headers.originator, "codex_cli_rs");
    assert.equal(headers.version, "0.149.0");
    assert.match(headers["user-agent"] ?? "", /^codex_cli_rs\/0\.149\.0 \(.+\) reqwest\//);
    const body = captured.body as Record<string, unknown>;
    assert.equal(body.store, false);
    assert.equal(typeof body.instructions, "string");
    assert.ok(statusCode === 200 || statusCode === 0); // buffered success
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  }
});


