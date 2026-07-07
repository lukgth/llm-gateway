// Admin authentication.
//
// The dashboard is gated by a single admin password. On boot we ensure a
// password hash + an HMAC signing secret exist in the `settings` table (a
// config.json adminPassword wins; otherwise one is generated and printed so
// the operator can log in on first run). Login exchanges the password for a
// stateless, HMAC-signed session token (base64url(payload).base64url(sig))
// that the SPA sends as `Authorization: Bearer <token>`.

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";
import { saveSettings, getSettings } from "../repo/settings";
import { sha256, timingSafeEqualStr } from "../config";

export interface AdminAuth {
  secret: string;
  ttlMs: number;
}

export interface AdminRequest extends Request {
  __admin?: boolean;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload: object, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

export function verifyToken(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expected = b64url(
    crypto.createHmac("sha256", secret).update(body).digest(),
  );
  // Lengths must match for a constant-time compare.
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return false;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as {
      exp?: number;
    };
    if (typeof payload.exp !== "number") return false;
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

function printPasswordBox(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const border = "─".repeat(width);
  // eslint-disable-next-line no-console
  console.log(
    `\n  ┌${border}┐\n` +
      lines.map((l) => `  │  ${l.padEnd(width - 4)}  │`).join("\n") +
      `\n  └${border}┘\n`,
  );
}

// Ensure a password hash and signing secret exist. Returns the live signing
// secret + session TTL. Idempotent.
export function initAdminAuth(
  db: DB,
  ttlMs: number,
  envPassword: string | null,
): AdminAuth {
  const settings = getSettings(db);
  const patch: Partial<{ adminPasswordHash: string; jwtSecret: string }> = {};

  if (envPassword) {
    const hash = sha256(envPassword);
    if (
      !settings.adminPasswordHash ||
      !timingSafeEqualStr(hash, settings.adminPasswordHash)
    ) {
      patch.adminPasswordHash = hash;
    }
  }
  if (!settings.jwtSecret) {
    patch.jwtSecret = crypto.randomBytes(32).toString("hex");
  }

  if (Object.keys(patch).length > 0) saveSettings(db, patch);

  let finalSettings = settings;
  if (Object.keys(patch).length > 0) finalSettings = getSettings(db);

  // First-run with no config password and no stored hash: generate a random
  // password so the dashboard is reachable, and print it once.
  if (!finalSettings.adminPasswordHash) {
    const generated = "admin-" + crypto.randomBytes(9).toString("base64url");
    saveSettings(db, { adminPasswordHash: sha256(generated) });
    printPasswordBox([
      "No admin password configured.",
      "Generated a one-time password for first login:",
      `  ${generated}`,
      'Add it to config.json as "adminPassword" to keep it,',
      "or change it from the dashboard Settings page.",
    ]);
  } else if (!envPassword) {
    // A hash is stored but config.json carries no password. The password is
    // unrecoverable from the hash — tell the operator how to reset instead of
    // silently booting into a dashboard they may be locked out of.
    printPasswordBox([
      "Admin password: using the one stored in the database.",
      'If you have lost it, set "adminPassword" in config.json',
      "and restart — it overrides the stored one.",
    ]);
  }

  return { secret: (finalSettings.jwtSecret || patch.jwtSecret)!, ttlMs };
}

export function login(
  db: DB,
  auth: AdminAuth,
  password: string,
): string | null {
  const settings = getSettings(db);
  if (!settings.adminPasswordHash) return null;
  if (!timingSafeEqualStr(sha256(password), settings.adminPasswordHash))
    return null;
  const exp = Date.now() + auth.ttlMs;
  return sign({ exp }, auth.secret);
}

export function changeAdminPassword(db: DB, newPassword: string): void {
  if (!newPassword || newPassword.length < 4) {
    throw new Error("Password must be at least 4 characters");
  }
  saveSettings(db, { adminPasswordHash: sha256(newPassword) });
}

export function adminAuthMiddleware(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bearer = (req.header("authorization") || "").replace(
      /^Bearer\s+/i,
      "",
    );
    const token = bearer || req.header("x-admin-token") || "";
    if (token && verifyToken(token, secret)) {
      (req as AdminRequest).__admin = true;
      return next();
    }
    res.status(401).json({
      error: { type: "unauthorized", message: "Admin authentication required" },
    });
  };
}

export function rotateSigningSecret(db: DB): string {
  const secret = crypto.randomBytes(32).toString("hex");
  saveSettings(db, { jwtSecret: secret });
  return secret;
}
