import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, closeDatabase } from "../../db";
import { ProviderAuthCrypto } from "./crypto";

test("provider auth encryption round-trips and authenticates record context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-"));
  const db = openDatabase(":memory:");
  try {
    const crypto = new ProviderAuthCrypto(db, dir);
    const a = crypto.encrypt("one", "cline-free", { token: "secret" });
    const b = crypto.encrypt("one", "cline-free", { token: "secret" });
    assert.notEqual(a, b);
    assert.deepEqual(crypto.decrypt("one", "cline-free", a), {
      token: "secret",
    });
    assert.throws(() => crypto.decrypt("two", "cline-free", a));
    assert.equal(a.includes("secret"), false);
    assert.equal(fs.statSync(path.join(dir, "provider-oauth.key")).mode & 0o077, 0);
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("provider auth rejects an existing key file with broad permissions", () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-mode-"));
  const db = openDatabase(":memory:");
  try {
    const keyPath = path.join(dir, "provider-oauth.key");
    fs.writeFileSync(keyPath, Buffer.alloc(32, 1).toString("base64") + "\n", {
      mode: 0o644,
    });
    assert.throws(
      () => new ProviderAuthCrypto(db, dir),
      /must not be accessible by group or other users/,
    );
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
