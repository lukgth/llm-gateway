import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, openDatabase } from "../db";
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  updateUser,
} from "./users";

test("createUser slugifies the name and round-trips fields", () => {
  const db = openDatabase(":memory:");
  try {
    const user = createUser(db, {
      name: "Jane Doe",
      email: "jane@example.com",
      notes: "ops",
    });
    assert.equal(user.id, "jane-doe");
    assert.equal(user.enabled, true);
    assert.equal(user.email, "jane@example.com");
    assert.equal(user.notes, "ops");
    assert.deepEqual(getUser(db, "jane-doe"), user);
  } finally {
    closeDatabase(db);
  }
});

test("createUser rejects a duplicate id and honours an explicit id", () => {
  const db = openDatabase(":memory:");
  try {
    const anon = createUser(db, { name: "", id: undefined });
    assert.match(anon.id, /^user-\d+$/);

    createUser(db, { name: "Duplicate", id: "fixed" });
    assert.throws(() => createUser(db, { name: "Duplicate", id: "fixed" }), {
      message: /already exists/,
    });
  } finally {
    closeDatabase(db);
  }
});

test("updateUser keeps omitted fields and can clear nullable ones", () => {
  const db = openDatabase(":memory:");
  try {
    const created = createUser(db, {
      name: "Jane Doe",
      email: "jane@example.com",
      notes: "ops",
      enabled: true,
    });

    const renamed = updateUser(db, created.id, { name: "Jane Roe" });
    assert.equal(renamed?.name, "Jane Roe");
    assert.equal(renamed?.email, "jane@example.com");
    assert.equal(renamed?.notes, "ops");

    const cleared = updateUser(db, created.id, { email: null, enabled: false });
    assert.equal(cleared?.email, null);
    assert.equal(cleared?.enabled, false);
    assert.equal(cleared?.name, "Jane Roe");
    assert.equal(updateUser(db, "missing", { name: "nobody" }), null);
  } finally {
    closeDatabase(db);
  }
});

test("listUsers sorts by name and deleteUser reports removal", () => {
  const db = openDatabase(":memory:");
  try {
    createUser(db, { name: "Zoe" });
    createUser(db, { name: "Alice" });
    assert.deepEqual(
      listUsers(db).map((u) => u.id),
      ["alice", "zoe"],
    );

    assert.equal(deleteUser(db, "alice"), true);
    assert.equal(deleteUser(db, "alice"), false);
    assert.equal(getUser(db, "alice"), null);
    assert.deepEqual(
      listUsers(db).map((u) => u.id),
      ["zoe"],
    );
  } finally {
    closeDatabase(db);
  }
});
