import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeResponsesResponse } from "./sanitize-responses-response";

test("responses-response: preserves valid statuses", () => {
  for (const s of [
    "completed",
    "incomplete",
    "in_progress",
    "failed",
    "cancelled",
  ]) {
    const body = sanitizeResponsesResponse({ id: "r1", status: s });
    assert.equal(body.status, s);
  }
});

test("responses-response: maps non-standard statuses", () => {
  const map: Record<string, string> = {
    end_turn: "completed",
    stop: "completed",
    max_tokens: "incomplete",
    length: "incomplete",
    tool_use: "completed",
    tool_calls: "completed",
    content_filter: "incomplete",
  };
  for (const [input, expected] of Object.entries(map)) {
    const body = sanitizeResponsesResponse({ id: "r1", status: input });
    assert.equal(body.status, expected, `${input} -> ${expected}`);
  }
});

test("responses-response: unknown status defaults to completed", () => {
  const body = sanitizeResponsesResponse({ id: "r1", status: "bizarre" });
  assert.equal(body.status, "completed");
});

test("responses-response: sets object to response when missing", () => {
  const body = sanitizeResponsesResponse({ id: "r1" });
  assert.equal(body.object, "response");
});
