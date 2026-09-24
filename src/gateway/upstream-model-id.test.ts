// Regression: an upstream model id ending in `-free` must be sent verbatim.
// No normalization anywhere may strip the `-free` suffix.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import type { AddressInfo } from "net";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { createModel, getModel } from "../repo/models";
import { Logger } from "../logger";
import { ThinkingConverter } from "../formats/thinking";
import { ForwardingEngine, type ForwardContext } from "./engine";
import type { Model } from "../types";

function quietLogger(): Logger {
  const l = new Logger();
  const noop = () => {};
  (l as unknown as { write: () => void }).write = noop;
  (l as unknown as { request: () => void }).request = noop;
  (l as unknown as { transform: () => void }).transform = noop;
  (l as unknown as { upstreamError: () => void }).upstreamError = noop;
  return l;
}

function mockRes() {
  const state = {
    statusCode: 0 as number,
    body: null as unknown,
    headersSent: false,
    writableEnded: false,
    headers: {} as Record<string, unknown>,
  };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    status(code: number) {
      state.statusCode = code;
      return {
        json(b: unknown) {
          state.body = b;
          state.headersSent = true;
          state.writableEnded = true;
        },
      };
    },
    setHeader(name: string, value: unknown) {
      state.headers[name] = value;
      return res;
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
    off() {
      return res;
    },
    writeHead(code: number, headers?: Record<string, unknown>) {
      state.statusCode = code;
      state.headers = headers ?? {};
      state.headersSent = true;
      return res;
    },
    end(chunk?: Buffer | string) {
      state.writableEnded = true;
      if (chunk === undefined) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      try {
        state.body = JSON.parse(text);
      } catch {
        state.body = text;
      }
    },
    write() {
      return true;
    },
  };
  return { res, state };
}

function ctxFor(
  model: Model,
  body: Record<string, unknown>,
  clientPath = "/v1/chat/completions",
): ForwardContext {
  return {
    clientPath,
    requestBody: body,
    resolvedModel: model,
    alias: model.alias,
    apiKey: null,
    inputTokens: 0,
    reservedTokens: 0,
    isStream: false,
    client: null,
    debug: false,
  };
}

test("forward() preserves a -free upstream model id verbatim in the outbound body", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        captured.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        captured.body = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeys: ["k-secret"],
      catalogId: "openai",
      authScheme: "bearer",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "free-model",
      providers: [{ providerId: "up", upstreamModel: "mimo-v2.5-free" }],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctxFor(model, {
        model: "free-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    assert.equal(state.statusCode || 200, 200);
    assert.equal(captured.body?.model, "mimo-v2.5-free");
  } finally {
    closeDatabase(db);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("debug request snapshot uses the upstream model when no usable key exists", async () => {
  const db = openDatabase(":memory:");
  try {
    createProvider(db, {
      id: "dead-up",
      name: "dead-up",
      baseUrl: "http://127.0.0.1:1",
      disabledApiKeys: ["k-dead"],
      catalogId: "openai",
      authScheme: "bearer",
      retryAttempts: 1,
    });
    const m = createModel(db, {
      alias: "anthropic/test",
      providers: [
        {
          providerId: "dead-up",
          upstreamModel: "muse-spark-1.3-contributor-free",
        },
      ],
    });
    const model = getModel(db, m.id)!;
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();
    const ctx = {
      ...ctxFor(model, {
        model: "anthropic/test",
        messages: [{ role: "user", content: "hi" }],
      }),
      debug: true,
    };
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctx,
    );
    assert.equal(state.statusCode, 502);
    const row = db
      .prepare(
        "SELECT upstream_model, debug_request FROM request_logs ORDER BY id DESC LIMIT 1",
      )
      .get() as { upstream_model: string | null; debug_request: string | null };
    assert.equal(row.upstream_model, "muse-spark-1.3-contributor-free");
    assert.ok(row.debug_request);
    const snapshot = JSON.parse(row.debug_request!);
    assert.equal(snapshot.model, "muse-spark-1.3-contributor-free");
  } finally {
    closeDatabase(db);
  }
});
