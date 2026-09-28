import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createModel } from "../repo/models";
import type { ApiKey } from "../types";
import { ModelRegistry } from "./registry";

test("registry resolves an extra alias to its owning model", () => {
  const db = openDatabase(":memory:");
  try {
    createModel(db, {
      id: "m1",
      alias: "deepseek-flash",
      aliases: ["deepseek-01"],
    });
    const registry = new ModelRegistry(db);

    assert.equal(registry.resolveModel("deepseek-flash").model?.alias, "deepseek-flash");
    assert.equal(registry.resolveModel("deepseek-01").model?.alias, "deepseek-flash");
    assert.equal(registry.resolveModel("nope").model, undefined);
  } finally {
    closeDatabase(db);
  }
});

test("registry listings expose only the primary alias", () => {
  const db = openDatabase(":memory:");
  try {
    createModel(db, {
      id: "m1",
      alias: "deepseek-flash",
      displayName: "DeepSeek Flash",
      contextWindow: 64000,
      aliases: ["deepseek-01", "deepseek-alt"],
    });
    const registry = new ModelRegistry(db);

    const openai = registry.listOpenAI().data;
    assert.deepEqual(openai.map((e) => e.id), [registry.exposedId("deepseek-flash")]);
    assert.equal(openai[0].canonical_slug, "deepseek-flash");
    assert.equal(openai[0].context_length, 64000);
    assert.equal(openai[0].name, "DeepSeek Flash");

    assert.deepEqual(
      registry.listAnthropic().data.map((m) => m.id),
      [registry.exposedId("deepseek-flash")],
    );
  } finally {
    closeDatabase(db);
  }
});

test("a model-restricted key reaches every alias of a granted model only", () => {
  const db = openDatabase(":memory:");
  try {
    createModel(db, {
      id: "m1",
      alias: "deepseek-flash",
      aliases: ["deepseek-01"],
    });
    createModel(db, { id: "m2", alias: "other-model" });
    const registry = new ModelRegistry(db);
    const key: ApiKey = {
      id: "k1",
      name: null,
      keyPrefix: "sk-",
      userId: null,
      userName: null,
      tokensPerDay: null,
      enabled: true,
      accessAllModels: false,
      modelIds: ["m1"],
      lastUsedAt: null,
      createdAt: "",
    };

    // Grants are per model, so an alias inherits its model's grant...
    assert.equal(registry.resolveModel("deepseek-flash", key).model?.id, "m1");
    assert.equal(registry.resolveModel("deepseek-01", key).model?.id, "m1");
    // ...and an ungranted model stays invisible under all its names.
    assert.deepEqual(registry.resolveModel("other-model", key), { error: 404 });

    const listed = registry.listOpenAI(key).data.map((e) => e.canonical_slug);
    assert.deepEqual(listed, ["deepseek-flash"]);
  } finally {
    closeDatabase(db);
  }
});
