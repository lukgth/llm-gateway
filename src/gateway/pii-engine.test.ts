// End-to-end PII redaction tests: a real engine, a real HTTP upstream, and a
// real Presidio-analyzer stand-in on 127.0.0.1.
//
// The contract under test is the whole point of the feature: the PROVIDER never
// sees the PII, the CLIENT always gets it back, and a hop whose redaction cannot
// run is skipped (never sent unredacted) in favour of a hop the operator
// configured without redaction.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { Writable } from "stream";
import type { AddressInfo } from "net";
import type { Database as DB } from "better-sqlite3";
import { openDatabase, closeDatabase } from "../db";
import { createProvider } from "../repo/providers";
import { createModel, getModel } from "../repo/models";
import { upsertProviderModel } from "../repo/provider-models";
import { listRequestLogs } from "../repo/request-logs";
import { Logger } from "../logger";
import { ThinkingConverter } from "../formats/thinking";
import { ForwardingEngine, type ForwardContext } from "./engine";
import { GatewayRouter } from "./router";
import { createServerApp } from "../server";
import { initAdminAuth } from "../auth/admin-auth";
import { saveSettings } from "../repo/settings";
import { ProviderAuthService } from "../services/provider-auth/service";
import { ProviderAuthCrypto } from "../services/provider-auth/crypto";
import { ProviderCredentialService } from "../services/provider-credentials";
import path from "path";
import os from "os";
import fs from "fs";
import type { PiiConfig } from "../pii";
import { PII_TRANSFORM_ID } from "../formats/transforms";
import type { Model } from "../types";

const ADMIN_PASSWORD = "pii-test-password";

// The real Express app (admin API + gateway /v1), with an in-memory DB. Used by
// the HTTP-level tests so the Settings routes and the router's ForwardContext
// assembly are covered, not just the engine.
function buildApp(db: DB) {
  const logger = quietLogger();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-http-"));
  const auth = initAdminAuth(db, 3_600_000, ADMIN_PASSWORD);
  const providerAuthCrypto = new ProviderAuthCrypto(db, dataDir);
  const router = new GatewayRouter(
    db,
    logger,
    0,
    new ProviderCredentialService(db, providerAuthCrypto),
  );
  return createServerApp({
    db,
    logger,
    router,
    auth,
    opts: {
      port: 0,
      dataDir,
      dbPath: ":memory:",
      webDistDir: "web/dist",
      webBasePath: "/",
      sessionTtlMs: 3_600_000,
      adminPassword: ADMIN_PASSWORD,
      configPath: null,
      corsOrigin: null,
    },
    providerAuth: new ProviderAuthService(db, providerAuthCrypto),
    providerCredentials: new ProviderCredentialService(db, providerAuthCrypto),
  });
}

function quietLogger(): Logger {
  const l = new Logger();
  const noop = () => {};
  (l as unknown as { write: () => void }).write = noop;
  (l as unknown as { request: () => void }).request = noop;
  (l as unknown as { transform: () => void }).transform = noop;
  (l as unknown as { upstreamError: () => void }).upstreamError = noop;
  // The live-HTTP test boots the real app, whose httpMiddleware logs every
  // request/response line on stdout.
  (l as unknown as { httpLog: () => void }).httpLog = noop;
  return l;
}

const PERSON = "Ada Lovelace";

// A Presidio analyzer stand-in: returns one PERSON span per occurrence of the
// test name in each text. `setFail(true)` makes it answer 500 (an unreachable
// or broken Presidio) while still counting attempts - that count is what proves
// the request-scoped "analyzer is down" latch.
interface Analyzer {
  url: string;
  calls: () => number;
  setFail: (v: boolean) => void;
  close: () => Promise<void>;
}

async function fakeAnalyzer(): Promise<Analyzer> {
  let calls = 0;
  let fail = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      // The Settings probe hits /health as well; only /analyze carries a body
      // and only /analyze counts as a detection attempt.
      if (!(req.url ?? "").startsWith("/analyze")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      calls++;
      if (fail) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("analyzer exploded");
        return;
      }
      const body = JSON.parse(raw) as { text: string[] };
      // "John Doe" is the name the Settings probe sends; the tests use "Ada".
      const spans = body.text.map((t) => {
        const out: Array<Record<string, unknown>> = [];
        for (const name of [PERSON, "John Doe"]) {
          let at = t.indexOf(name);
          while (at !== -1) {
            out.push({
              entity_type: "PERSON",
              start: at,
              end: at + name.length,
              score: 0.9,
            });
            at = t.indexOf(name, at + name.length);
          }
        }
        return out.sort(
          (a, b) => (a.start as number) - (b.start as number),
        );
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(spans));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    setFail: (v) => {
      fail = v;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// An upstream that records every request body it receives. When `setRaw` has
// primed SSE chunks it answers with those instead of the JSON reply.
interface Upstream {
  url: string;
  bodies: unknown[];
  requests: () => number;
  setRaw: (chunks: string[]) => void;
  close: () => Promise<void>;
}

async function recordingUpstream(
  reply: (body: unknown) => string,
): Promise<Upstream> {
  const bodies: unknown[] = [];
  const raw: string[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      bodies.push(JSON.parse(data) as unknown);
      if (raw.length) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of raw) res.write(chunk);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(reply(JSON.parse(data) as unknown));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    requests: () => bodies.length,
    setRaw: (chunks) => raw.push(...chunks),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// A buffered Express-ish response capturing status + JSON body.
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

// A Writable usable as the streaming `res`, accumulating the SSE text.
function streamRes() {
  const state = { statusCode: 0, headers: {} as Record<string, unknown>, text: "" };
  const w = new Writable({
    write(chunk, _enc, cb) {
      state.text += chunk.toString("utf8");
      cb();
    },
  }) as Writable & {
    headersSent: boolean;
    writeHead: (c: number, h?: Record<string, unknown>) => unknown;
    status: (c: number) => { json: (b: unknown) => void };
  };
  w.headersSent = false;
  w.writeHead = (code: number, h?: Record<string, unknown>) => {
    state.statusCode = code;
    state.headers = h ?? {};
    w.headersSent = true;
    return w;
  };
  w.status = (code: number) => ({
    json: () => {
      state.statusCode = code;
      w.headersSent = true;
    },
  });
  return { res: w, state };
}

const ASSISTANT_REPLY = (content: string) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });

interface HopSpec {
  upstreamModel: string;
  /** Import the model WITH the PII-redaction transform; omitted = no row. */
  importedPii?: boolean;
  /** Per-link override (null/undefined = inherit). */
  linkPii?: boolean | null;
  providerUrl: string;
}

// Build one provider (+ imported model) per hop and a model whose chain is
// exactly `hops`, in order.
function seed(db: DB, hops: HopSpec[]): Model {
  const links: Array<{
    providerId: string;
    upstreamModel: string;
    piiRedaction?: boolean | null;
  }> = [];
  hops.forEach((hop, i) => {
    const id = `p${i + 1}`;
    createProvider(db, {
      id,
      name: id,
      baseUrl: hop.providerUrl,
      apiKeys: [`k${i + 1}`],
      retryAttempts: 1,
    });
    if (hop.importedPii !== undefined) {
      upsertProviderModel(db, {
        providerId: id,
        upstreamId: hop.upstreamModel,
        // Opting in IS adding the library switch to the model's transforms -
        // there is no separate boolean any more.
        transforms: hop.importedPii
          ? [{ id: PII_TRANSFORM_ID, phase: "request", params: {} }]
          : [],
      });
    }
    links.push({
      providerId: id,
      upstreamModel: hop.upstreamModel,
      piiRedaction: hop.linkPii,
    });
  });
  const created = createModel(db, { alias: "test-model", providers: links });
  return getModel(db, created.id)!;
}

function ctxFor(
  model: Model,
  pii: PiiConfig | undefined,
  over: Partial<ForwardContext> = {},
): ForwardContext {
  return {
    clientPath: "/v1/chat/completions",
    requestBody: {
      model: "test-model",
      messages: [{ role: "user", content: `My name is ${PERSON}` }],
    },
    resolvedModel: model,
    alias: model.alias,
    apiKey: null,
    inputTokens: 0,
    reservedTokens: 0,
    isStream: false,
    client: null,
    debug: false,
    pii,
    ...over,
  };
}

// The single user message the client sent, from an upstream-captured body.
function userContent(body: unknown): string {
  const msgs = (body as { messages: Array<{ role: string; content: string }> })
    .messages;
  return msgs.find((m) => m.role === "user")!.content;
}

test("a redacted hop: provider sees tokens, client gets the original back", async () => {
  const analyzer = await fakeAnalyzer();
  const upstream = await recordingUpstream(() =>
    ASSISTANT_REPLY(`Sure - [[PII_PERSON_1]] it is.`),
  );
  const db = openDatabase(":memory:");
  try {
    const model = seed(db, [
      {
        upstreamModel: "up-1",
        importedPii: true,
        providerUrl: upstream.url,
      },
    ]);
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
        analyzerUrl: analyzer.url,
        language: "en",
        scoreThreshold: 0.5,
        entities: [],
        timeoutMs: 2000,
      }),
    );

    assert.equal(state.statusCode, 200);
    // The provider never saw the name.
    const sent = userContent(upstream.bodies[0]);
    assert.ok(!sent.includes(PERSON), `upstream saw the raw name: ${sent}`);
    assert.equal(sent, "My name is [[PII_PERSON_1]]");
    // The client sees it restored.
    const reply = (
      state.body as { choices: Array<{ message: { content: string } }> }
    ).choices[0].message.content;
    assert.equal(reply, `Sure - ${PERSON} it is.`);
    assert.ok(!reply.includes("[[PII_"));
  } finally {
    closeDatabase(db);
    await upstream.close();
    await analyzer.close();
  }
});

test("streaming: a token split across SSE chunk boundaries is restored", async () => {
  const analyzer = await fakeAnalyzer();
  const upstream = await recordingUpstream(() => "");
  // The token is split mid-marker across two upstream writes - the rehydrator
  // must hold the partial marker back rather than leak it to the client.
  upstream.setRaw([
    'data: {"choices":[{"delta":{"content":"Hi [[PII_PERSON_1',
    ']] there"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const db = openDatabase(":memory:");
  try {
    const model = seed(db, [
      {
        upstreamModel: "up-1",
        importedPii: true,
        providerUrl: upstream.url,
      },
    ]);
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = streamRes();

    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctxFor(
        model,
        {
          analyzerUrl: analyzer.url,
          language: "en",
          scoreThreshold: 0.5,
          entities: [],
          timeoutMs: 2000,
        },
        { isStream: true, requestBody: { model: "test-model", stream: true, messages: [{ role: "user", content: `My name is ${PERSON}` }] } },
      ),
    );

    assert.equal(state.statusCode, 200);
    assert.ok(
      state.text.includes(`Hi ${PERSON} there`),
      `client stream lost the original: ${state.text}`,
    );
    assert.ok(!state.text.includes("[[PII_"), state.text);
  } finally {
    closeDatabase(db);
    await upstream.close();
    await analyzer.close();
  }
});

test("a broken analyzer skips the hop, latches, and fails over to a hop without redaction", async () => {
  const analyzer = await fakeAnalyzer();
  analyzer.setFail(true);
  const first = await recordingUpstream(() => ASSISTANT_REPLY("from hop 1"));
  const second = await recordingUpstream(() => ASSISTANT_REPLY("from hop 2"));
  const third = await recordingUpstream(() => ASSISTANT_REPLY("from hop 3"));
  const db = openDatabase(":memory:");
  try {
    // Hop 1 and hop 2 both need redaction; only hop 3 does not. The latch must
    // carry the failure across hop 2 WITHOUT a second analyzer round-trip.
    const model = seed(db, [
      { upstreamModel: "up-1", importedPii: true, providerUrl: first.url },
      { upstreamModel: "up-2", importedPii: true, providerUrl: second.url },
      { upstreamModel: "up-3", importedPii: false, providerUrl: third.url },
    ]);
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
        analyzerUrl: analyzer.url,
        language: "en",
        scoreThreshold: 0.5,
        entities: [],
        timeoutMs: 2000,
      }),
    );

    assert.equal(state.statusCode, 200);
    assert.equal(
      (
        state.body as { choices: Array<{ message: { content: string } }> }
      ).choices[0].message.content,
      "from hop 3",
    );
    // No opted-in hop ever received the request.
    assert.equal(first.requests(), 0);
    assert.equal(second.requests(), 0);
    // Hop 3 was configured WITHOUT redaction, so it gets the raw body.
    assert.equal(third.requests(), 1);
    assert.ok(userContent(third.bodies[0]).includes(PERSON));
    // The latch: exactly one analyzer attempt, not one per opted-in hop.
    assert.equal(analyzer.calls(), 1);
  } finally {
    closeDatabase(db);
    await first.close();
    await second.close();
    await third.close();
    await analyzer.close();
  }
});

test("every hop needs redaction and the analyzer is down: 502, no upstream request", async () => {
  const analyzer = await fakeAnalyzer();
  analyzer.setFail(true);
  const first = await recordingUpstream(() => ASSISTANT_REPLY("never"));
  const second = await recordingUpstream(() => ASSISTANT_REPLY("never"));
  const db = openDatabase(":memory:");
  try {
    const model = seed(db, [
      { upstreamModel: "up-1", importedPii: true, providerUrl: first.url },
      { upstreamModel: "up-2", importedPii: true, providerUrl: second.url },
    ]);
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
        analyzerUrl: analyzer.url,
        language: "en",
        scoreThreshold: 0.5,
        entities: [],
        timeoutMs: 2000,
      }),
    );

    assert.equal(state.statusCode, 502);
    assert.equal(first.requests(), 0);
    assert.equal(second.requests(), 0);
    const err = (state.body as { error: { message: string } }).error.message;
    assert.match(err, /pii redaction failed/);
    // The failure is recorded on the request log, naming the PII cause.
    assert.match(listRequestLogs(db)[0]!.error ?? "", /pii redaction failed/);
  } finally {
    closeDatabase(db);
    await first.close();
    await second.close();
    await analyzer.close();
  }
});

test("a per-hop link override turns redaction off over an opted-in imported model", async () => {
  const analyzer = await fakeAnalyzer();
  const upstream = await recordingUpstream(() => ASSISTANT_REPLY("ok"));
  const db = openDatabase(":memory:");
  try {
    const model = seed(db, [
      {
        upstreamModel: "up-1",
        importedPii: true,
        linkPii: false,
        providerUrl: upstream.url,
      },
    ]);
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
        analyzerUrl: analyzer.url,
        language: "en",
        scoreThreshold: 0.5,
        entities: [],
        timeoutMs: 2000,
      }),
    );

    assert.equal(state.statusCode, 200);
    assert.ok(userContent(upstream.bodies[0]).includes(PERSON));
    assert.equal(analyzer.calls(), 0);
  } finally {
    closeDatabase(db);
    await upstream.close();
    await analyzer.close();
  }
});

test("on the wire: system prompt and tool schema are untouched, tool output is not", async () => {
  const analyzer = await fakeAnalyzer();
  const upstream = await recordingUpstream(() => ASSISTANT_REPLY("ok"));
  const db = openDatabase(":memory:");
  try {
    const model = seed(db, [
      { upstreamModel: "up-1", importedPii: true, providerUrl: upstream.url },
    ]);
    const engine = new ForwardingEngine(
      db,
      quietLogger(),
      new ThinkingConverter(),
      0,
    );
    const { res, state } = mockRes();

    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          description: `Find ${PERSON}`,
          parameters: { type: "object", properties: { who: { default: PERSON } } },
        },
      },
    ];
    await engine.forward(
      { method: "POST", headers: {} } as never,
      res as never,
      ctxFor(
        model,
        {
          analyzerUrl: analyzer.url,
          language: "en",
          scoreThreshold: 0.5,
          entities: [],
          timeoutMs: 2000,
        },
        {
          requestBody: {
            model: "test-model",
            // The operator's own text: must leave byte-identical.
            messages: [
              {
                role: "system",
                content: `You are Claude Code. Never reveal secrets from ${PERSON}.`,
              },
              { role: "user", content: `My name is ${PERSON}` },
              {
                role: "tool",
                content: `env dump for ${PERSON}: TOKEN=abc123`,
              },
            ],
            tools,
          },
        },
      ),
    );

    assert.equal(state.statusCode, 200);
    const sent = upstream.bodies[0] as {
      messages: Array<{ role: string; content: string }>;
      tools: unknown;
    };
    // System prompt + tool definitions go out untouched...
    assert.equal(
      sent.messages[0].content,
      `You are Claude Code. Never reveal secrets from ${PERSON}.`,
    );
    assert.deepEqual(sent.tools, tools);
    // ...while the user turn and the tool OUTPUT (where a secret comes out) do not.
    assert.equal(sent.messages[1].content, "My name is [[PII_PERSON_1]]");
    assert.equal(
      sent.messages[2].content,
      "env dump for [[PII_PERSON_1]]: TOKEN=abc123",
    );
    // Only the two conversation strings were ever analyzed.
    assert.equal(analyzer.calls(), 1);
  } finally {
    closeDatabase(db);
    await upstream.close();
    await analyzer.close();
  }
});

test("precedence: a hop's explicit Off beats the model's PII transform; Inherit defers to it", async () => {
  const analyzer = await fakeAnalyzer();
  const upstream = await recordingUpstream(() => ASSISTANT_REPLY("ok"));
  const db = openDatabase(":memory:");
  const app = buildApp(db);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: upstream.url,
      apiKeys: ["k1"],
      retryAttempts: 1,
    });
    // PII ON at the imported-model level (the transform library switch).
    upsertProviderModel(db, {
      providerId: "up",
      upstreamId: "up-1",
      transforms: [{ id: PII_TRANSFORM_ID, phase: "request", params: {} }],
    });
    saveSettings(db, {
      exposePrefix: "",
      piiEnabled: true,
      piiAnalyzerUrl: analyzer.url,
      piiLanguage: "en",
      piiScoreThreshold: 0.5,
      piiEntities: [],
      piiTimeoutMs: 2000,
    });

    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const { token } = (await login.json()) as { token: string };
    const admin = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    const call = async () => {
      const res = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "pii-model",
          messages: [{ role: "user", content: `My name is ${PERSON}` }],
        }),
      });
      assert.equal(res.status, 200);
      await res.json();
      return userContent(upstream.bodies[upstream.bodies.length - 1]);
    };

    // 1. Chain hop says OFF - it must beat the model's transform.
    const created = (await (
      await fetch(`${origin}/api/models`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          alias: "pii-model",
          providers: [
            { providerId: "up", upstreamModel: "up-1", piiRedaction: false },
          ],
        }),
      })
    ).json()) as { id: string };
    assert.equal(await call(), `My name is ${PERSON}`);
    assert.equal(analyzer.calls(), 0, "an Off hop must not call the analyzer");

    // 2. Chain hop says INHERIT - the model's transform decides, so it redacts.
    const put = async (piiRedaction: boolean | null) => {
      const res = await fetch(`${origin}/api/models/${created.id}`, {
        method: "PUT",
        headers: admin,
        body: JSON.stringify({
          alias: "pii-model",
          providers: [{ providerId: "up", upstreamModel: "up-1", piiRedaction }],
        }),
      });
      assert.equal(res.status, 200);
      // The value survived the round trip through the API + DB.
      const saved = (await res.json()) as {
        providers: Array<{ piiRedaction: boolean | null }>;
      };
      return saved.providers[0].piiRedaction;
    };
    assert.equal(await put(null), null);
    assert.equal(await call(), "My name is [[PII_PERSON_1]]");

    // 3. Chain hop says ON explicitly - redacts too.
    assert.equal(await put(true), true);
    assert.equal(await call(), "My name is [[PII_PERSON_1]]");

    // 4. And back to OFF: the hop wins again.
    assert.equal(await put(false), false);
    assert.equal(await call(), `My name is ${PERSON}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    closeDatabase(db);
    await upstream.close();
    await analyzer.close();
  }
});

test("cross-format: a Messages client against a chat-native provider restores PII after the bridge", async () => {
  const analyzer = await fakeAnalyzer();
  // The upstream speaks chat; the gateway bridges chat -> messages for the
  // client. The re-hydrator must run on the FINAL client-format bytes, after
  // that bridge.
  const upstream = await recordingUpstream(() =>
    ASSISTANT_REPLY(`Sure - [[PII_PERSON_1]] it is.`),
  );
  const db = openDatabase(":memory:");
  try {
    const model = seed(db, [
      {
        upstreamModel: "up-1",
        importedPii: true,
        providerUrl: upstream.url,
      },
    ]);
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
      ctxFor(
        model,
        {
          analyzerUrl: analyzer.url,
          language: "en",
          scoreThreshold: 0.5,
          entities: [],
          timeoutMs: 2000,
        },
        {
          clientPath: "/v1/messages",
          requestBody: {
            model: "test-model",
            max_tokens: 64,
            messages: [{ role: "user", content: `My name is ${PERSON}` }],
          },
        },
      ),
    );

    assert.equal(state.statusCode, 200);
    const sent = userContent(upstream.bodies[0]);
    assert.ok(!sent.includes(PERSON), `upstream saw the raw name: ${sent}`);
    assert.ok(sent.includes("[[PII_PERSON_1]]"));
    const content = (
      state.body as { content: Array<{ type: string; text: string }> }
    ).content;
    assert.equal(content[0].text, `Sure - ${PERSON} it is.`);
  } finally {
    closeDatabase(db);
    await upstream.close();
    await analyzer.close();
  }
});

test("the live HTTP surface wires settings → chain → redaction end to end", async () => {
  // Everything below drives the REAL Express app, so the Settings whitelist,
  // the router's ForwardContext assembly and the engine's chain build are all
  // covered - the layers the direct-engine tests deliberately bypass.
  const analyzer = await fakeAnalyzer();
  const upstream = await recordingUpstream(() =>
    ASSISTANT_REPLY(`Sure - [[PII_PERSON_1]] it is.`),
  );
  const db = openDatabase(":memory:");
  const app = buildApp(db);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // A provider + imported model opted in to redaction, and an exposed alias.
    createProvider(db, {
      id: "up",
      name: "up",
      baseUrl: upstream.url,
      apiKeys: ["k1"],
      retryAttempts: 1,
    });
    upsertProviderModel(db, {
      providerId: "up",
      upstreamId: "up-1",
      transforms: [{ id: PII_TRANSFORM_ID, phase: "request", params: {} }],
    });
    createModel(db, {
      alias: "pii-model",
      providers: [{ providerId: "up", upstreamModel: "up-1" }],
    });

    // Configure redaction through the admin API (exercises the PUT whitelist
    // and the WS push payload alike).
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const { token } = (await login.json()) as { token: string };
    const put = await fetch(`${origin}/api/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        exposePrefix: "",
        piiEnabled: true,
        piiAnalyzerUrl: analyzer.url,
        piiAnonymizerUrl: "",
        piiLanguage: "en",
        piiScoreThreshold: 0.5,
        piiEntities: [],
        piiTimeoutMs: 2000,
      }),
    });
    assert.equal(put.status, 200);
    const saved = (await put.json()) as Record<string, unknown>;
    assert.equal(saved.piiEnabled, true);
    assert.equal(saved.piiAnalyzerUrl, analyzer.url);
    assert.deepEqual(saved.piiEntities, []);

    // A real gateway request over HTTP.
    const res = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pii-model",
        messages: [{ role: "user", content: `My name is ${PERSON}` }],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(body.choices[0].message.content, `Sure - ${PERSON} it is.`);

    const sent = userContent(upstream.bodies[0]);
    assert.equal(sent, "My name is [[PII_PERSON_1]]");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    closeDatabase(db);
    await upstream.close();
    await analyzer.close();
  }
});

test("the Settings probe endpoint reports the analyzer it can reach", async () => {
  const analyzer = await fakeAnalyzer();
  const db = openDatabase(":memory:");
  const app = buildApp(db);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    saveSettings(db, { piiAnalyzerUrl: analyzer.url, piiTimeoutMs: 2000 });
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const { token } = (await login.json()) as { token: string };
    const res = await fetch(`${origin}/api/settings/pii/test`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      analyzer: { ok: boolean; entities?: string[] };
      anonymizer: { ok: boolean; detail: string };
    };
    assert.equal(body.analyzer.ok, true);
    assert.deepEqual(body.analyzer.entities, ["PERSON"]);
    // No anonymizer configured: reported, not crashed.
    assert.equal(body.anonymizer.ok, false);
    assert.equal(body.ok, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    closeDatabase(db);
    await analyzer.close();
  }
});

test("the master switch off (no pii config) leaves the body untouched", async () => {
  const upstream = await recordingUpstream(() => ASSISTANT_REPLY("ok"));
  const db = openDatabase(":memory:");
  try {
    const model = seed(db, [
      {
        upstreamModel: "up-1",
        importedPii: true,
        providerUrl: upstream.url,
      },
    ]);
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
      ctxFor(model, undefined),
    );

    assert.equal(state.statusCode, 200);
    assert.ok(userContent(upstream.bodies[0]).includes(PERSON));
  } finally {
    closeDatabase(db);
    await upstream.close();
  }
});
