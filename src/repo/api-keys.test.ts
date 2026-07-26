import { test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, openDatabase } from "../db";
import { ModelRegistry } from "../gateway/registry";
import { createModel, deleteModel, updateModel } from "./models";
import {
  createApiKey,
  getApiKey,
  getApiKeyByHash,
  updateApiKey,
} from "./api-keys";
import { sha256 } from "../config";

function model(db: ReturnType<typeof openDatabase>, id: string, enabled = true) {
  return createModel(db, { id, alias: id, enabled });
}

test("API key model scopes round-trip and preserve partial updates", () => {
  const db = openDatabase(":memory:");
  try {
    model(db, "m1");
    model(db, "m2", false);

    const unrestricted = createApiKey(db, { id: "all" }, "sk-all");
    assert.equal(unrestricted.accessAllModels, true);
    assert.deepEqual(unrestricted.modelIds, []);

    const restricted = createApiKey(
      db,
      {
        id: "restricted",
        accessAllModels: false,
        modelIds: ["m2", "m1", "m1"],
      },
      "sk-restricted",
    );
    assert.equal(restricted.accessAllModels, false);
    assert.deepEqual(restricted.modelIds, ["m1", "m2"]);
    assert.deepEqual(getApiKeyByHash(db, sha256("sk-restricted"))?.modelIds, [
      "m1",
      "m2",
    ]);

    const renamed = updateApiKey(db, "restricted", { name: "renamed" })!;
    assert.equal(renamed.accessAllModels, false);
    assert.deepEqual(renamed.modelIds, ["m1", "m2"]);

    const empty = updateApiKey(db, "restricted", {
      accessAllModels: false,
      modelIds: [],
    })!;
    assert.equal(empty.accessAllModels, false);
    assert.deepEqual(empty.modelIds, []);

    const all = updateApiKey(db, "restricted", {
      accessAllModels: true,
      modelIds: [],
    })!;
    assert.equal(all.accessAllModels, true);
    assert.deepEqual(all.modelIds, []);
  } finally {
    closeDatabase(db);
  }
});

test("invalid scope updates roll back and model deletion never widens access", () => {
  const db = openDatabase(":memory:");
  try {
    model(db, "m1");
    createApiKey(
      db,
      { id: "key", name: "before", accessAllModels: false, modelIds: ["m1"] },
      "sk-key",
    );

    assert.throws(
      () =>
        updateApiKey(db, "key", {
          name: "after",
          accessAllModels: false,
          modelIds: ["missing"],
        }),
      /Unknown exposed model/,
    );
    assert.equal(getApiKey(db, "key")?.name, "before");
    assert.deepEqual(getApiKey(db, "key")?.modelIds, ["m1"]);

    deleteModel(db, "m1");
    const key = getApiKey(db, "key")!;
    assert.equal(key.accessAllModels, false);
    assert.deepEqual(key.modelIds, []);
  } finally {
    closeDatabase(db);
  }
});

test("registry filters both listing shapes and blocks unknown for restricted keys", () => {
  const db = openDatabase(":memory:");
  try {
    model(db, "m1");
    model(db, "m2");
    const key = createApiKey(
      db,
      { id: "key", accessAllModels: false, modelIds: ["m1"] },
      "sk-key",
    );
    const registry = new ModelRegistry(db);

    assert.deepEqual(registry.listOpenAI(key).data.map((m) => m.id), [
      "anthropic/m1",
    ]);
    assert.deepEqual(registry.listAnthropic(key).data.map((m) => m.id), [
      "anthropic/m1",
    ]);
    assert.equal(registry.resolveModel("m1", key).model?.id, "m1");
    assert.equal(registry.resolveModel("m2", key).error, 404);

    updateModel(db, "m1", { enabled: false });
    registry.reload();
    assert.deepEqual(registry.listOpenAI(key).data, []);
    assert.equal(registry.resolveModel("m1", key).error, 404);
  } finally {
    closeDatabase(db);
  }
});
