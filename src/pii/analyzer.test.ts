// Presidio analyzer client tests: the request shape it sends, the way it
// normalizes the reply, and the rule that matters most for privacy - a
// misconfigured or broken Presidio must THROW (so the engine skips the hop),
// never degrade into a silent pass-through.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { analyzeTexts, probePresidio, type PiiConfig } from "./analyzer";

interface FakeService {
  url: string;
  bodies: unknown[];
  paths: string[];
  close: () => Promise<void>;
}

// A tiny HTTP stand-in whose handler can be pointed at any route.
async function fakeService(
  handler: (path: string, body: unknown, res: http.ServerResponse) => void,
): Promise<FakeService> {
  const bodies: unknown[] = [];
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw.length ? (JSON.parse(raw) as unknown) : null;
      bodies.push(body);
      paths.push(req.url ?? "");
      handler(req.url ?? "", body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    paths,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const cfg = (over: Partial<PiiConfig> = {}): PiiConfig => ({
  analyzerUrl: "",
  language: "en",
  scoreThreshold: 0.5,
  entities: [],
  timeoutMs: 2000,
  ...over,
});

test("analyzeTexts posts every text in one array request and normalizes spans", async (t) => {
  const svc = await fakeService((path, _body, res) => {
    assert.equal(path, "/analyze");
    json(res, [
      [
        { entity_type: "PERSON", start: 0, end: 3, score: 0.9 },
        // Malformed spans are dropped, never trusted.
        { entity_type: "EMAIL_ADDRESS", start: 9, end: 4, score: 0.9 },
        { entity_type: "URL", start: "nah", end: 2, score: 0.9 },
      ],
      "not-an-array",
      [{ start: 1, end: 3 }],
    ]);
  });
  t.after(svc.close);

  const spans = await analyzeTexts(cfg({ analyzerUrl: svc.url }), [
    "Ada",
    "second",
    "third",
  ]);

  assert.deepEqual(svc.bodies[0], {
    text: ["Ada", "second", "third"],
    language: "en",
    score_threshold: 0.5,
  });
  assert.deepEqual(spans[0], [
    { entity_type: "PERSON", start: 0, end: 3, score: 0.9 },
  ]);
  assert.deepEqual(spans[1], []);
  // A span with no entity_type still reports, as UNKNOWN.
  assert.deepEqual(spans[2], [
    { entity_type: "UNKNOWN", start: 1, end: 3, score: 0 },
  ]);
});

test("a non-empty entity list is sent; an empty one is omitted (blank = all)", async (t) => {
  const svc = await fakeService((_p, _b, res) => json(res, [[]]));
  t.after(svc.close);

  await analyzeTexts(
    cfg({ analyzerUrl: `${svc.url}/`, entities: ["PERSON"] }),
    ["x"],
  );
  assert.deepEqual(svc.bodies[0], {
    text: ["x"],
    language: "en",
    score_threshold: 0.5,
    entities: ["PERSON"],
  });
  // A trailing slash must not produce a double slash.
  assert.equal(svc.paths[0], "/analyze");
});

test("an unconfigured analyzer URL throws instead of passing content through", async () => {
  await assert.rejects(() => analyzeTexts(cfg(), ["Ada"]), /not configured/);
  await assert.rejects(
    () => analyzeTexts(cfg({ analyzerUrl: "   " }), ["Ada"]),
    /not configured/,
  );
});

test("a non-2xx analyzer response throws with the status and body excerpt", async (t) => {
  const svc = await fakeService((_p, _b, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("model not loaded");
  });
  t.after(svc.close);

  await assert.rejects(
    () => analyzeTexts(cfg({ analyzerUrl: svc.url }), ["Ada"]),
    /analyzer 503: model not loaded/,
  );
});

test("probePresidio reports both services and the detected entity types", async (t) => {
  const analyzer = await fakeService((path, _b, res) => {
    if (path === "/health") return json(res, { status: "ok" });
    return json(res, [
      [
        { entity_type: "PERSON", start: 11, end: 19, score: 0.85 },
        { entity_type: "EMAIL_ADDRESS", start: 41, end: 61, score: 0.85 },
      ],
    ]);
  });
  const anonymizer = await fakeService((_p, _b, res) =>
    json(res, { status: "ok" }),
  );
  t.after(analyzer.close);
  t.after(anonymizer.close);

  const r = await probePresidio({
    analyzerUrl: analyzer.url,
    anonymizerUrl: anonymizer.url,
    language: "en",
    timeoutMs: 2000,
  });

  assert.equal(r.ok, true);
  assert.equal(r.analyzer.ok, true);
  assert.equal(r.anonymizer.ok, true);
  assert.deepEqual(r.analyzer.entities, ["EMAIL_ADDRESS", "PERSON"]);
});

test("probePresidio encodes failures as ok:false rather than throwing", async (t) => {
  // A closed port stands in for "Presidio isn't running".
  const dead = await fakeService((_p, _b, res) => json(res, {}));
  const deadUrl = dead.url;
  await dead.close();

  const healthyAnalyzer = await fakeService((_p, _b, res) =>
    json(res, [[{ entity_type: "PERSON", start: 11, end: 19, score: 0.9 }]]),
  );
  t.after(healthyAnalyzer.close);

  const r = await probePresidio({
    analyzerUrl: healthyAnalyzer.url,
    anonymizerUrl: deadUrl,
    language: "en",
    timeoutMs: 500,
  });

  assert.equal(r.ok, false);
  assert.equal(r.analyzer.ok, true);
  assert.equal(r.anonymizer.ok, false);
  assert.notEqual(r.anonymizer.detail, "");
});

test("probePresidio with nothing configured reports both sides down", async () => {
  const r = await probePresidio({
    analyzerUrl: "",
    anonymizerUrl: "",
    language: "en",
    timeoutMs: 500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.analyzer.detail, "not configured");
  assert.equal(r.anonymizer.detail, "not configured");
});
