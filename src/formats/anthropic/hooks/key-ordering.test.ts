// Verify that Anthropic Messages bodies are serialized with keys in
// ORDERED_KEYS order — the order the Anthropic API expects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ORDERED_KEYS } from "./sanitize-request";

test("ORDERED_KEYS serialization order: keys appear in canonical order after rebuild", () => {
  // Simulate a body with keys in random order (as hooks might leave them).
  const body: Record<string, unknown> = {
    stream: true,
    max_tokens: 4096,
    model: "claude-opus-4-8",
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }],
    system: [{ type: "text", text: "be helpful" }],
    temperature: 0.7,
    tools: [{ name: "f", input_schema: {} }],
    metadata: { user_id: "u-1" },
    output_config: { effort: "high" },
    stop_sequences: ["END"],
    top_p: 0.9,
    top_k: 40,
    tool_choice: { type: "auto" },
    cache_control: { type: "ephemeral" },
    context_management: { edits: [] },
  };

  // Rebuild in ORDERED_KEYS order (same logic as sanitize-request and
  // the AnthropicCompatibleAdapter.messages() build method).
  const ordered: Record<string, unknown> = {};
  for (const key of ORDERED_KEYS) {
    if (key in body) ordered[key] = body[key];
  }
  for (const key of Object.keys(body)) {
    if (!(key in ordered)) ordered[key] = body[key];
  }

  const serialized = JSON.stringify(ordered);
  const keys = Object.keys(JSON.parse(serialized));

  // Every key that's in ORDERED_KEYS should appear in that order.
  const orderedKeysPresent = ORDERED_KEYS.filter((k) => k in body);
  const actualOrderedKeys = keys.filter((k) =>
    (ORDERED_KEYS as readonly string[]).includes(k),
  );
  assert.deepEqual(
    actualOrderedKeys,
    orderedKeysPresent,
    "Keys should appear in ORDERED_KEYS order after serialization",
  );

  // First key should be "model".
  assert.equal(keys[0], "model");
  // "messages" should be second.
  assert.equal(keys[1], "messages");
  // "stream" should be near the end.
  assert.ok(
    keys.indexOf("stream") > keys.indexOf("stop_sequences"),
    "stream should come after stop_sequences",
  );
});

test("ORDERED_KEYS: unknown keys are preserved at the end", () => {
  const body: Record<string, unknown> = {
    unknown_field: "test",
    model: "claude-opus-4-8",
    messages: [],
    max_tokens: 100,
    another_custom: true,
  };

  const ordered: Record<string, unknown> = {};
  for (const key of ORDERED_KEYS) {
    if (key in body) ordered[key] = body[key];
  }
  for (const key of Object.keys(body)) {
    if (!(key in ordered)) ordered[key] = body[key];
  }

  const keys = Object.keys(ordered);
  assert.equal(keys[0], "model");
  assert.equal(keys[1], "messages");
  assert.equal(keys[2], "max_tokens");
  // Unknown keys come after all ordered keys.
  assert.ok(keys.indexOf("unknown_field") > keys.indexOf("max_tokens"));
  assert.ok(keys.indexOf("another_custom") > keys.indexOf("max_tokens"));
});
