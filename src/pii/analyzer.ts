// Presidio analyzer client.
//
// The gateway only needs the analyzer's DETECTION half: it asks for spans and
// substitutes its own per-occurrence placeholders (see redact.ts), because the
// Presidio HTTP anonymizer cannot emit a unique indexed placeholder per
// occurrence - it only does per-entity-type replace/mask/redact, or opaque
// `encrypt` ciphertext that models mangle. Every throw in here is a hard
// failure: the engine turns it into a hop skip, so a request that needs
// redaction is never forwarded unredacted.

export interface PiiConfig {
  analyzerUrl: string;
  language: string;
  scoreThreshold: number;
  entities: string[];
  timeoutMs: number;
}

export interface PiiSpan {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export interface ProbeResult {
  ok: boolean;
  analyzer: { ok: boolean; detail: string; entities?: string[] };
  anonymizer: { ok: boolean; detail: string };
}

function base(url: string): string {
  return url.replace(/\/+$/, "");
}

// Coerce one analyzed text's span list; anything malformed is dropped rather
// than trusted (a bad offset would splice the wrong characters out).
function normalizeSpans(raw: unknown): PiiSpan[] {
  if (!Array.isArray(raw)) return [];
  const out: PiiSpan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const start = Number(s.start);
    const end = Number(s.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || start >= end) continue;
    out.push({
      entity_type: typeof s.entity_type === "string" ? s.entity_type : "UNKNOWN",
      start,
      end,
      score: typeof s.score === "number" ? s.score : 0,
    });
  }
  return out;
}

/** Analyze N texts in ONE request. Always sends an array body, so the response
 *  is always an array of per-text span lists. Throws on any error. */
export async function analyzeTexts(
  cfg: PiiConfig,
  texts: string[],
): Promise<PiiSpan[][]> {
  // A blank URL must be a hard failure, never a silent pass-through: the hop
  // asked for redaction and cannot get it.
  if (!cfg.analyzerUrl.trim())
    throw new Error("PII analyzer URL is not configured");
  const body: Record<string, unknown> = {
    text: texts,
    language: cfg.language,
    score_threshold: cfg.scoreThreshold,
  };
  // Presidio reads an empty `entities` array as "no entities", which would
  // defeat the "blank = all" default - so only send it when we mean it.
  if (cfg.entities.length > 0) body.entities = cfg.entities;

  const res = await fetch(`${base(cfg.analyzerUrl)}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok)
    throw new Error(
      `analyzer ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  const json = (await res.json()) as unknown;
  const rows = Array.isArray(json) ? json : [];
  return texts.map((_, i) => normalizeSpans(rows[i]));
}

// Best-effort single GET/POST used by the Settings probe. Never throws.
async function tryFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
      return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** Probe the configured Presidio deployment for the Settings test button.
 *  Reports each service separately and NEVER throws. */
export async function probePresidio(cfg: {
  analyzerUrl: string;
  anonymizerUrl: string;
  language: string;
  timeoutMs: number;
}): Promise<ProbeResult> {
  const analyzerUrl = cfg.analyzerUrl.trim();
  const anonymizerUrl = cfg.anonymizerUrl.trim();

  const analyzerMissing = !analyzerUrl;
  const analyzerHealth = analyzerMissing
    ? Promise.resolve({ ok: false, detail: "not configured" })
    : tryFetch(
        `${base(analyzerUrl)}/health`,
        { method: "GET" },
        cfg.timeoutMs,
      );

  const anonymizerHealth = !anonymizerUrl
    ? Promise.resolve({ ok: false, detail: "not configured" })
    : tryFetch(
        `${base(anonymizerUrl)}/health`,
        { method: "GET" },
        cfg.timeoutMs,
      );

  const [health, anonHealth] = await Promise.all([
    analyzerHealth,
    anonymizerHealth,
  ]);

  // Exercise the real detection path (health alone wouldn't catch a broken
  // model set), and report the entity types we actually saw.
  let entities: string[] | undefined;
  let analyzeDetail = health.detail;
  let analyzeOk = false;
  if (!analyzerMissing) {
    try {
      const spans = await analyzeTexts(
        {
          analyzerUrl,
          language: cfg.language,
          scoreThreshold: 0.5,
          entities: [],
          timeoutMs: cfg.timeoutMs,
        },
        ["My name is John Doe and my email is john.doe@example.com"],
      );
      entities = [...new Set(spans[0].map((s) => s.entity_type))].sort();
      analyzeDetail = entities.length
        ? `detected ${entities.join(", ")}`
        : "reachable, but detected nothing";
      analyzeOk = true;
    } catch (err) {
      analyzeDetail = (err as Error).message;
    }
  }

  return {
    ok: analyzeOk && anonHealth.ok,
    analyzer: { ok: analyzeOk, detail: analyzeDetail, entities },
    anonymizer: anonHealth,
  };
}
