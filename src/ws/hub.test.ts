import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { closeDatabase, openDatabase } from "../db";
import type { Logger } from "../logger";
import { WsHub } from "./hub";
import type { WsRequest } from "./schema";

const logger = { info() {}, warn() {}, error() {} } as unknown as Logger;

function fakeSocket(sent: string[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => sent.push(data),
    terminate() {},
    close() {},
  } as unknown as WebSocket;
}

const parse = (raw: string): Record<string, unknown> => JSON.parse(raw);

test("handleRequest answers a known topic and rejects unknown endpoints", () => {
  const db = openDatabase(":memory:");
  try {
    const sent: string[] = [];
    const hub = new WsHub(db, logger);
    const client = hub.addClient(fakeSocket(sent));

    hub.handleRequest(client, {
      type: "request",
      id: "req-1",
      endpoint: "overview",
    } as WsRequest);
    const ok = parse(sent.at(-1)!);
    assert.equal(ok.type, "response");
    assert.equal(ok.id, "req-1");
    assert.equal(ok.error, undefined);
    const data = ok.data as Record<string, unknown>;
    assert.equal(typeof data.stats, "object");
    assert.equal(typeof data.providers, "number");
    assert.equal(typeof data.models, "number");

    hub.handleRequest(client, {
      type: "request",
      id: "req-2",
      endpoint: "nope",
    } as unknown as WsRequest);
    assert.deepEqual(parse(sent.at(-1)!), {
      type: "response",
      id: "req-2",
      error: { message: "unknown endpoint: nope" },
    });

    hub.shutdown();
  } finally {
    closeDatabase(db);
  }
});

test("subscribe rejects unknown topics and accepts valid ones", () => {
  const db = openDatabase(":memory:");
  try {
    const sent: string[] = [];
    const hub = new WsHub(db, logger);
    const client = hub.addClient(fakeSocket(sent));

    hub.subscribe(client, "nope" as never);
    assert.deepEqual(parse(sent.at(-1)!), {
      type: "error",
      message: "unknown topic: nope",
    });

    hub.subscribe(client, "overview");
    const push = parse(sent.at(-1)!);
    assert.equal(push.type, "push");
    assert.equal(push.topic, "overview");

    hub.shutdown();
  } finally {
    closeDatabase(db);
  }
});

test("broadcast reaches only clients subscribed to an affected topic", () => {
  const db = openDatabase(":memory:");
  try {
    const hub = new WsHub(db, logger);
    const subscribed: string[] = [];
    const bystander: string[] = [];
    const a = hub.addClient(fakeSocket(subscribed));
    hub.addClient(fakeSocket(bystander));
    hub.subscribe(a, "overview");
    subscribed.length = 0;

    hub.broadcast(["overview"], "provider:update");

    assert.equal(subscribed.length, 2, "invalidate + refreshed push");
    assert.deepEqual(parse(subscribed[0]), {
      type: "invalidate",
      topics: ["overview"],
      source: "provider:update",
    });
    assert.equal(parse(subscribed[1]).type, "push");
    assert.equal(bystander.length, 0);

    hub.shutdown();
  } finally {
    closeDatabase(db);
  }
});
