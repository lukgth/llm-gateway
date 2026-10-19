import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { closeDatabase, openDatabase } from "../db";
import {
  adminAuthMiddleware,
  changeAdminPassword,
  initAdminAuth,
  login,
  verifyToken,
} from "./admin-auth";
import { getSettings } from "../repo/settings";

const b64url = (v: Buffer | string): string =>
  Buffer.from(v).toString("base64url");

/** Mirrors the private signer so expiry/signature branches can be exercised. */
function signPayload(payload: Record<string, unknown>, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(
    crypto.createHmac("sha256", secret).update(body).digest(),
  )}`;
}

function fakeReq(headers: Record<string, string>) {
  return {
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.payload = payload;
      return res;
    },
  };
  return res as typeof res & Response;
}

test("initAdminAuth persists a config password and is idempotent", () => {
  const db = openDatabase(":memory:");
  try {
    const first = initAdminAuth(db, 60_000, "config-pass");
    assert.equal(first.ttlMs, 60_000);
    assert.match(first.secret, /^[0-9a-f]{64}$/);

    const second = initAdminAuth(db, 60_000, "config-pass");
    assert.equal(second.secret, first.secret, "signing secret must be stable");

    const auth = { secret: first.secret, ttlMs: first.ttlMs };
    const token = login(db, auth, "config-pass");
    assert.ok(token);
    assert.equal(verifyToken(token, first.secret), true);
    assert.equal(login(db, auth, "wrong-pass"), null);
  } finally {
    closeDatabase(db);
  }
});

test("initAdminAuth generates and announces a password on first run", () => {
  const db = openDatabase(":memory:");
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const auth = initAdminAuth(db, 1_000, null);
    const output = lines.join("\n");
    assert.match(output, /Generated a one-time password/);
    const generated = /admin-[A-Za-z0-9_-]+/.exec(output)?.[0];
    assert.ok(generated, "generated password must be printed");
    assert.ok(
      getSettings(db).adminPasswordHash,
      "generated password hash must be stored",
    );
    const token = login(db, auth, generated!);
    assert.ok(token, "generated password must authenticate");
  } finally {
    console.log = original;
    closeDatabase(db);
  }
});

test("verifyToken rejects malformed, tampered, and expired tokens", () => {
  const secret = "s3cret";
  assert.equal(verifyToken("", secret), false);
  assert.equal(verifyToken("no-dot", secret), false);
  assert.equal(verifyToken("a.b.c", secret), false);

  const valid = signPayload({ exp: Date.now() + 60_000 }, secret);
  assert.equal(verifyToken(valid, secret), true);
  assert.equal(verifyToken(valid, "other-secret"), false);
  assert.equal(
    verifyToken(`${valid}x`, secret),
    false,
    "trailing signature bytes must fail",
  );
  assert.equal(
    verifyToken(signPayload({ exp: "soon" }, secret), secret),
    false,
    "non-numeric exp must fail",
  );
  assert.equal(
    verifyToken(signPayload({ exp: Date.now() - 1_000 }, secret), secret),
    false,
    "expired token must fail",
  );
});

test("changeAdminPassword enforces a length floor and rotates the login", () => {
  const db = openDatabase(":memory:");
  try {
    const auth = initAdminAuth(db, 60_000, "old-pass");
    assert.throws(() => changeAdminPassword(db, "abc"), /at least 4/);
    changeAdminPassword(db, "new-pass");
    assert.equal(login(db, auth, "old-pass"), null);
    assert.ok(login(db, auth, "new-pass"));
  } finally {
    closeDatabase(db);
  }
});

test("adminAuthMiddleware gates the dashboard and binds the session", () => {
  const db = openDatabase(":memory:");
  try {
    const auth = initAdminAuth(db, 60_000, "config-pass");
    const middleware = adminAuthMiddleware(auth.secret);
    const token = login(db, auth, "config-pass")!;

    const unauthorized = fakeRes();
    let nextCalls = 0;
    middleware(fakeReq({}), unauthorized, (() => {
      nextCalls += 1;
    }) as NextFunction);
    assert.equal(nextCalls, 0);
    assert.equal(unauthorized.statusCode, 401);
    assert.deepEqual(unauthorized.payload, {
      error: { type: "unauthorized", message: "Admin authentication required" },
    });

    const badToken = fakeRes();
    middleware(fakeReq({ authorization: "Bearer nope.nope" }), badToken, () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 0);
    assert.equal(badToken.statusCode, 401);

    const authorized = fakeRes();
    const req = fakeReq({
      authorization: `Bearer ${token}`,
    }) as Request & {
      __admin?: boolean;
      __adminSessionBinding?: string;
    };
    middleware(req, authorized, (() => {
      nextCalls += 1;
    }) as NextFunction);
    assert.equal(nextCalls, 1);
    assert.equal(req.__admin, true);
    assert.match(req.__adminSessionBinding ?? "", /^[0-9a-f]{64}$/);

    const viaHeaderToken = fakeRes();
    middleware(fakeReq({ "x-admin-token": token }), viaHeaderToken, (() => {
      nextCalls += 1;
    }) as NextFunction);
    assert.equal(nextCalls, 2, "x-admin-token is accepted as an alternative");
  } finally {
    closeDatabase(db);
  }
});
