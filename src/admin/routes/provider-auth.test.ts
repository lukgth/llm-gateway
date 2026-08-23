// POST /api/provider-auth/sessions/import - exercises the registered route
// through the module's own RouteCtx contract: an in-memory DB, the REAL
// ProviderAuthService wired to the real Codex integration (with an injected
// fake fetch), and a stub credential service. Asserts ready token-free views,
// secret-free error shapes, and one-shot consumption via provider creation.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";
import { openDatabase, closeDatabase } from "../../db";
import { getProviderOAuth, listProviderOAuthViews } from "../../repo/provider-oauth";
import { createProvider } from "../../repo/providers";
import { ProviderAuthCrypto } from "../../services/provider-auth/crypto";
import { ProviderAuthService } from "../../services/provider-auth/service";
import type { RouteCtx } from "./types";
import { registerProviderAuthRoutes } from "./provider-auth";

// --- JWT fixtures -------------------------------------------------------------

function b64url(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const EXP = Math.floor(Date.now() / 1000) + 3_600;
const ACCESS_SECRET = "route-test-access-secret";
const AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: `h.${b64url({
      email: "route@example.com",
      exp: EXP,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-route" },
    })}.s`,
    refresh_token: "route-refresh-secret",
    id_token: `h.${b64url({ email: "id@example.com", exp: EXP })}.s`,
  },
});

// --- harness ------------------------------------------------------------------

interface RecordedResponse {
  status: number;
  body?: unknown;
}

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-route-"));
  const db = openDatabase(":memory:");
  const crypto = new ProviderAuthCrypto(db, dir);
  const providerAuth = new ProviderAuthService(db, crypto);
  const handlers = new Map<
    string,
    Array<(req: Request, res: Response) => unknown>
  >();
  const r = {
    post: (routePath: string, ...middleware: unknown[]) => {
      const handler = middleware[middleware.length - 1] as (
        req: Request,
        res: Response,
      ) => unknown;
      const list = handlers.get(`POST ${routePath}`) ?? [];
      list.push(handler);
      handlers.set(`POST ${routePath}`, list);
    },
    get: () => {},
    put: () => {},
    delete: () => {},
  };
  const ctx = {
    db,
    logger: {},
    router: { reload: () => {} },
    r,
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    broadcast: () => {},
    bootstrap: {},
    providerAuth,
    providerCredentials: {} as never,
  } as unknown as RouteCtx;
  registerProviderAuthRoutes(ctx);

  const callImport = async (body: unknown): Promise<RecordedResponse> => {
    const handler = handlers.get(
      "POST /provider-auth/sessions/import",
    )![0];

    let captured: RecordedResponse | undefined;
    const res = {
      status(code: number) {
        return {
          json(payload: unknown) {
            captured = { status: code, body: payload };
          },
        };
      },
    } as unknown as Response;

    await handler(
      ownerBinding({ body } as unknown as Request),
      res,
    );
    assert.ok(captured, "handler must respond");
    return captured!;
  };

  return {
    db,
    crypto,
    providerAuth,
    callImport,
    close() {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ownerBinding(req: Request): Request {
  // The route reads req.__adminSessionBinding for ownership.
  (req as unknown as Record<string, unknown>).__adminSessionBinding =
    "owner-route";
  return req;
}

test("import route returns a ready token-free view and persists nothing until adoption", async () => {
  const harness = makeCtx();
  try {
    const result = await harness.callImport({
      catalogId: "openai-codex",
      kind: "auth_json",
      value: AUTH_JSON,
    });
    assert.equal(result.status, 201);
    const view = result.body as Record<string, unknown>;
    assert.equal(view.state, "ready");
    assert.equal(view.flow, "import");
    assert.equal((view.catalogId as string), "openai-codex");
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes(ACCESS_SECRET), false);
    assert.equal(serialized.includes("route-refresh-secret"), false);
    assert.deepEqual((view.account as Record<string, unknown>).accountId, "acct-route");
  } finally {
    harness.close();
  }
});

test("import route rejects malformed input with the standard error shape and no secrets", async () => {
  const harness = makeCtx();
  try {
    for (const body of [
      { kind: "auth_json", value: AUTH_JSON }, // missing catalogId
      { catalogId: "openai-codex", kind: "carrier_pigeon", value: AUTH_JSON },
      { catalogId: "openai-codex", kind: "auth_json", value: "" },
      { catalogId: "clinefree", kind: "auth_json", value: AUTH_JSON }, // no import support
      { catalogId: "nope", kind: "auth_json", value: AUTH_JSON },
    ]) {
      const result = await harness.callImport(body);
      assert.equal(result.status, 400);
      assert.match(
        ((result.body as Record<string, unknown>).error as Record<string, unknown>)
          .message as string,
        /.+/,
      );
      assert.equal(JSON.stringify(result.body).includes(ACCESS_SECRET), false);
    }
    // Malformed auth JSON surfaces its message without echoing the payload.
    const badJson = await harness.callImport({
      catalogId: "openai-codex",
      kind: "auth_json",
      value: ACCESS_SECRET,
    });
    assert.equal(badJson.status, 400);
    assert.equal(JSON.stringify(badJson.body).includes(ACCESS_SECRET), false);
  } finally {
    harness.close();
  }
});

test("provider creation consumes the imported session into one encrypted OAuth row", async () => {
  const harness = makeCtx();
  try {
    const started = await harness.callImport({
      catalogId: "openai-codex",
      kind: "auth_json",
      value: AUTH_JSON,
    });
    const view = started.body as { id: string };

    // Simulate POST /providers with authSessionId (the managed-create path).
    const provider = createProvider(harness.db, {
      id: "codex-created",
      name: "OpenAI Codex",
      baseUrl: "https://chatgpt.com",
      basePath: "/backend-api/codex",
      modelsPath: "/models",
      endpoints: ["responses", "chat"],
      authScheme: "bearer",
      catalogId: "openai-codex",
    });
    const oauth = harness.providerAuth.adoptForNewProvider(
      view.id,
      "owner-route",
      provider.id,
      "openai-codex",
    );
    assert.equal(oauth.status, "active");
    const rows = listProviderOAuthViews(harness.db, provider.id);
    assert.equal(rows.length, 1);
    const stored = getProviderOAuth(harness.db, harness.crypto, provider.id)!;
    // The imported access JWT round-trips through the encrypted store.
    const accessTokenInFixture = JSON.parse(AUTH_JSON).tokens.access_token;
    assert.equal(stored.credential.secrets.accessToken, accessTokenInFixture);
    assert.ok(stored.credential.secrets.refreshToken);
    // Session consumed exactly once.
    assert.throws(() =>
      harness.providerAuth.adoptForNewProvider(view.id, "owner-route", provider.id, "openai-codex"),
    );
  } finally {
    harness.close();
  }
});
