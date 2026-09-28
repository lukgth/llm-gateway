import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "./providers";
import {
  batchModelLinks,
  createModel,
  deleteModel,
  getModel,
  listModels,
  updateModel,
} from "./models";

function setup() {
  const db = openDatabase(":memory:");
  for (const id of ["p1", "p2", "p3"]) {
    createProvider(db, {
      id,
      name: id,
      baseUrl: `https://${id}.example.com`,
    });
  }
  const model = createModel(db, {
    id: "model-1",
    alias: "model",
    providers: [
      { providerId: "p1", upstreamModel: "a" },
      { providerId: "p2", upstreamModel: "b" },
    ],
  });
  return { db, model };
}

test("model-link batch adds, updates, removes, and reorders a subset atomically", () => {
  const { db, model } = setup();
  try {
    const result = batchModelLinks(db, model.id, {
      add: [{ providerId: "p3", upstreamModel: "c", enabled: false }],
      update: [
        {
          providerId: "p1",
          upstreamModel: "a",
          endpoint: "/custom",
          contextWindow: 200000,
        },
      ],
      remove: [{ providerId: "p2", upstreamModel: "b" }],
      reorder: [{ providerId: "p3", upstreamModel: "c" }],
    });

    assert.deepEqual(
      {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        reordered: result.reordered,
      },
      { added: 1, updated: 1, removed: 1, reordered: 1 },
    );
    assert.deepEqual(
      result.model.providers.map((link) => [
        link.providerId,
        link.upstreamModel,
        link.priority,
      ]),
      [
        ["p3", "c", 0],
        ["p1", "a", 1],
      ],
    );
    const updated = result.model.providers[1];
    assert.equal(updated.endpoint, "/custom");
    assert.equal(updated.contextWindow, 200000);
  } finally {
    closeDatabase(db);
  }
});

test("model-link batch rolls back all writes on an invalid identity", () => {
  const { db, model } = setup();
  try {
    assert.throws(() =>
      batchModelLinks(db, model.id, {
        add: [{ providerId: "p3", upstreamModel: "c" }],
        update: [
          { providerId: "missing", upstreamModel: "nope", enabled: false },
        ],
      }),
    );
    assert.deepEqual(
      getModel(db, model.id)!.providers.map((link) => [
        link.providerId,
        link.upstreamModel,
      ]),
      [
        ["p1", "a"],
        ["p2", "b"],
      ],
    );
  } finally {
    closeDatabase(db);
  }
});

test("model-link reorder rejects duplicate identities without changing priorities", () => {
  const { db, model } = setup();
  try {
    const duplicate = { providerId: "p2", upstreamModel: "b" };
    assert.throws(() =>
      batchModelLinks(db, model.id, { reorder: [duplicate, duplicate] }),
    );
    assert.deepEqual(
      getModel(db, model.id)!.providers.map((link) => link.providerId),
      ["p1", "p2"],
    );
  } finally {
    closeDatabase(db);
  }
});

test("createModel stores extra aliases and rejects duplicates and collisions", () => {
  const db = openDatabase(":memory:");
  try {
    createModel(db, {
      id: "m1",
      alias: "deepseek-flash",
      aliases: [" deepseek-01 ", "deepseek-01-max"],
    });
    assert.deepEqual(getModel(db, "m1")!.aliases, [
      "deepseek-01",
      "deepseek-01-max",
    ]);

    assert.throws(
      () =>
        createModel(db, { id: "m2", alias: "other", aliases: ["dup", "dup"] }),
      /Duplicate alias 'dup'/,
    );
    assert.throws(
      () =>
        createModel(db, {
          id: "m3",
          alias: "third",
          aliases: ["deepseek-flash"],
        }),
      /Model alias 'deepseek-flash' is already in use/,
    );
    assert.throws(
      () =>
        createModel(db, {
          id: "m4",
          alias: "fourth",
          aliases: ["deepseek-01"],
        }),
      /Model alias 'deepseek-01' is already in use/,
    );
    assert.throws(
      () => createModel(db, { id: "m5", alias: "fifth", aliases: ["fifth"] }),
      /Model alias 'fifth' is already in use/,
    );
    assert.throws(
      () => createModel(db, { id: "m6", alias: "sixth", aliases: ["   "] }),
      /must not be empty/,
    );
    // Nothing leaked from the rejected creates.
    assert.deepEqual(listModels(db).map((m) => m.alias), ["deepseek-flash"]);
  } finally {
    closeDatabase(db);
  }
});

test("updateModel replaces, clears, and leaves aliases untouched", () => {
  const db = openDatabase(":memory:");
  try {
    createModel(db, { id: "m1", alias: "a", aliases: ["a-1", "a-2"] });

    // undefined = untouched (unrelated edits must not drop extras)
    updateModel(db, "m1", { displayName: "A" });
    assert.deepEqual(getModel(db, "m1")!.aliases, ["a-1", "a-2"]);

    // re-sending the model's own extras is not a self-collision
    updateModel(db, "m1", { aliases: ["a-1", "a-2"] });
    assert.deepEqual(getModel(db, "m1")!.aliases, ["a-1", "a-2"]);

    // a new list replaces
    updateModel(db, "m1", { aliases: ["a-3"] });
    assert.deepEqual(getModel(db, "m1")!.aliases, ["a-3"]);

    // [] and null both clear
    updateModel(db, "m1", { aliases: [] });
    assert.deepEqual(getModel(db, "m1")!.aliases, []);
    updateModel(db, "m1", { aliases: ["a-4"] });
    updateModel(db, "m1", { aliases: null });
    assert.deepEqual(getModel(db, "m1")!.aliases, []);

    // another model's primary alias cannot be taken
    createModel(db, { id: "m2", alias: "b" });
    assert.throws(
      () => updateModel(db, "m1", { aliases: ["b"] }),
      /Model alias 'b' is already in use/,
    );
    assert.deepEqual(getModel(db, "m1")!.aliases, []);
  } finally {
    closeDatabase(db);
  }
});

test("deleting a model cascades its extra alias rows", () => {
  const db = openDatabase(":memory:");
  try {
    createModel(db, { id: "m1", alias: "a", aliases: ["a-1", "a-2"] });
    assert.equal(
      (db.prepare("SELECT * FROM model_aliases").all() as unknown[]).length,
      2,
    );
    assert.equal(deleteModel(db, "m1"), true);
    assert.equal(
      (db.prepare("SELECT * FROM model_aliases").all() as unknown[]).length,
      0,
    );
  } finally {
    closeDatabase(db);
  }
});
