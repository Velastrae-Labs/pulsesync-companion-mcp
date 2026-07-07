// PulseSync reference Worker — a thin, user-owned receiver + read API.
//
// Two credential planes, never mixed:
//   INGEST_TOKEN — write plane. Only the PulseSync app should hold this.
//   READ_TOKEN   — read plane. Only your AI-assistant MCP should hold this.
//
// The Worker validates, dedupes on sample UUID, inserts, and answers
// read-only aggregate queries. No interpretation, no medical logic.
//
// Logging policy: this Worker NEVER logs tokens or health payload contents.
// Only status codes and counts, and sparingly.

export interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
  READ_TOKEN: string;
}

const SCHEMA_V = 1;
const MAX_BATCH = 500;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// v1 sample types accepted on ingest. Additive — extend freely, never remove.
const KNOWN_TYPES = new Set([
  "heartRate",
  "heartRateVariabilitySDNN",
  "restingHeartRate",
  "oxygenSaturation",
  "appleSleepingWristTemperature",
  "sleepAnalysis",
  "stepCount",
  "activeEnergyBurned",
  "appleExerciseTime",
  "appleStandTime",
  "appleStandHour",
  "workout",
  "respiratoryRate",
  "mindfulSession",
  "menstrualFlow",
]);

function isKnownType(type: string): boolean {
  // Subjective capture (mood, energy, focus, custom logs) lives under a
  // namespace prefix so future subjective sample names remain additive —
  // older deployed Workers keep accepting them without a migration.
  return KNOWN_TYPES.has(type) || type.startsWith("subjective.");
}

interface IncomingSample {
  uuid: string;
  type: string;
  value?: number | null;
  unit?: string | null;
  start_ts: number;
  end_ts: number;
  source: string;
  device?: string | null;
  metadata?: Record<string, unknown> | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validateSample(s: unknown): string | null {
  if (!s || typeof s !== "object") return "not an object";
  const x = s as Record<string, unknown>;
  if (typeof x.uuid !== "string" || x.uuid.length < 8 || x.uuid.length > 128)
    return "bad uuid";
  if (typeof x.type !== "string" || !x.type) return "missing type";
  if (!isKnownType(x.type)) return `unknown type '${x.type}'`;
  if (x.value !== null && x.value !== undefined && typeof x.value !== "number")
    return "value must be number or null";
  if (!Number.isFinite(x.start_ts) || !Number.isFinite(x.end_ts))
    return "start_ts/end_ts must be epoch ms numbers";
  if ((x.end_ts as number) < (x.start_ts as number))
    return "end_ts before start_ts";
  if (typeof x.source !== "string" || !x.source) return "missing source";
  return null;
}

/** Constant-time-ish bearer check. Never log the presented token. */
function bearerMatches(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token.length !== expected.length) return false;
  const enc = new TextEncoder();
  const a = enc.encode(token);
  const b = enc.encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Time helpers — all day boundaries are UTC unless the caller passes
// tz_offset (minutes east of UTC, e.g. -300 for US Eastern in winter).
// ---------------------------------------------------------------------------

function parseTzOffset(url: URL): number {
  const raw = url.searchParams.get("tz_offset");
  if (raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -840 || n > 840) return 0;
  return Math.trunc(n);
}

/** [startMs, endMs) of the given YYYY-MM-DD day in the caller's offset. */
function dayBounds(date: string, tzOffsetMin: number): [number, number] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(utcMidnight)) return null;
  const start = utcMidnight - tzOffsetMin * 60_000;
  return [start, start + 86_400_000];
}

function parseRange(url: URL): { from: number; to: number } {
  const now = Date.now();
  const from = Number(url.searchParams.get("from")) || now - 86_400_000;
  const to = Number(url.searchParams.get("to")) || now;
  return { from: Math.trunc(from), to: Math.trunc(to) };
}

function parseLimit(url: URL): number {
  const n = Number(url.searchParams.get("limit")) || DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(n)), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Source dedupe for cumulative types (stepCount, activeEnergyBurned).
//
// HealthKit often records the same activity from both the watch and the
// phone with overlapping windows; summing both double-counts. Strategy:
// group each day's samples by source; if a "watch" source contributed
// samples that day, use only the watch total for that day; otherwise use
// the sum of the remaining sources. This is a day-granularity heuristic —
// simple, deterministic, and documented — not per-interval overlap
// resolution.
// ---------------------------------------------------------------------------

const CUMULATIVE_DEDUPE_TYPES = new Set(["stepCount", "activeEnergyBurned"]);

interface DaySourceRow {
  day: string;
  source: string;
  total: number;
  n: number;
}

function dedupeDayTotals(rows: DaySourceRow[]): Map<string, { total: number; n: number; source: string }> {
  const byDay = new Map<string, DaySourceRow[]>();
  for (const r of rows) {
    const arr = byDay.get(r.day) ?? [];
    arr.push(r);
    byDay.set(r.day, arr);
  }
  const out = new Map<string, { total: number; n: number; source: string }>();
  for (const [day, arr] of byDay) {
    const watch = arr.filter((r) => r.source === "watch");
    if (watch.length > 0) {
      out.set(day, {
        total: watch.reduce((s, r) => s + r.total, 0),
        n: watch.reduce((s, r) => s + r.n, 0),
        source: "watch (preferred over overlapping phone data)",
      });
    } else {
      out.set(day, {
        total: arr.reduce((s, r) => s + r.total, 0),
        n: arr.reduce((s, r) => s + r.n, 0),
        source: arr.map((r) => r.source).join("+"),
      });
    }
  }
  return out;
}

/** SQL day expression for start_ts shifted by tz offset. */
function dayExpr(tzOffsetMin: number): string {
  // date() accepts unixepoch seconds; shift into the caller's local day.
  return `date((start_ts + ${tzOffsetMin * 60_000}) / 1000, 'unixepoch')`;
}

async function cumulativeDayTotals(
  db: D1Database,
  type: string,
  from: number,
  to: number,
  tzOffsetMin: number
): Promise<Map<string, { total: number; n: number; source: string }>> {
  const { results } = await db
    .prepare(
      `SELECT ${dayExpr(tzOffsetMin)} AS day, source, SUM(value) AS total, COUNT(*) AS n
       FROM samples WHERE type = ? AND start_ts >= ? AND start_ts < ?
       GROUP BY day, source`
    )
    .bind(type, from, to)
    .all<DaySourceRow>();
  return dedupeDayTotals(results ?? []);
}

// ---------------------------------------------------------------------------
// Read handlers (all guarded by READ_TOKEN)
// ---------------------------------------------------------------------------

async function handleStatus(env: Env): Promise<Response> {
  const totals = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MIN(start_ts) AS earliest, MAX(start_ts) AS latest, MAX(received_at) AS last_received FROM samples"
  ).first<{ n: number; earliest: number | null; latest: number | null; last_received: number | null }>();
  const { results: types } = await env.DB.prepare(
    "SELECT type, COUNT(*) AS n, MAX(start_ts) AS latest FROM samples GROUP BY type ORDER BY n DESC"
  ).all<{ type: string; n: number; latest: number }>();
  return json({
    ok: true,
    samples: totals?.n ?? 0,
    earliest_ts: totals?.earliest ?? null,
    latest_ts: totals?.latest ?? null,
    last_received_at: totals?.last_received ?? null,
    types: types ?? [],
  });
}

async function handleSamples(env: Env, url: URL): Promise<Response> {
  const type = url.searchParams.get("type");
  const { from, to } = parseRange(url);
  const limit = parseLimit(url);
  const base =
    "SELECT uuid, type, value, unit, start_ts, end_ts, source, device, metadata FROM samples WHERE start_ts >= ? AND start_ts < ?";
  const stmt = type
    ? env.DB.prepare(`${base} AND type = ? ORDER BY start_ts DESC LIMIT ?`).bind(from, to, type, limit)
    : env.DB.prepare(`${base} ORDER BY start_ts DESC LIMIT ?`).bind(from, to, limit);
  const { results } = await stmt.all();
  return json({ from, to, type: type ?? "all", count: results?.length ?? 0, samples: results ?? [] });
}

async function handleDailySummary(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const tz = parseTzOffset(url);
  const bounds = date ? dayBounds(date, tz) : null;
  if (!date || !bounds) return json({ error: "date must be YYYY-MM-DD" }, 400);
  const [from, to] = bounds;

  // Point-in-time / averaged metrics straight from SQL.
  const { results: stats } = await env.DB.prepare(
    `SELECT type, COUNT(*) AS n, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max
     FROM samples
     WHERE start_ts >= ? AND start_ts < ?
       AND type IN ('heartRate','heartRateVariabilitySDNN','restingHeartRate',
                    'oxygenSaturation','respiratoryRate','appleSleepingWristTemperature')
     GROUP BY type`
  )
    .bind(from, to)
    .all<{ type: string; n: number; avg: number; min: number; max: number }>();

  // Cumulative metrics with source dedupe (see note at top of file).
  const cumulative: Record<string, unknown> = {};
  for (const t of CUMULATIVE_DEDUPE_TYPES) {
    const days = await cumulativeDayTotals(env.DB, t, from, to, tz);
    const entry = days.get(date);
    cumulative[t] = entry
      ? { total: entry.total, sample_count: entry.n, source: entry.source }
      : { total: 0, sample_count: 0, source: "none" };
  }

  const exercise = await env.DB.prepare(
    "SELECT SUM(value) AS total, COUNT(*) AS n FROM samples WHERE type = 'appleExerciseTime' AND start_ts >= ? AND start_ts < ?"
  )
    .bind(from, to)
    .first<{ total: number | null; n: number }>();

  const totalRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM samples WHERE start_ts >= ? AND start_ts < ?"
  )
    .bind(from, to)
    .first<{ n: number }>();

  return json({
    date,
    tz_offset: tz,
    from,
    to,
    total_samples: totalRow?.n ?? 0,
    metrics: stats ?? [],
    cumulative,
    exercise_minutes: { total: exercise?.total ?? 0, sample_count: exercise?.n ?? 0 },
    dedupe_note:
      "stepCount and activeEnergyBurned prefer watch-sourced samples when watch and phone overlap on the same day.",
  });
}

async function handleSleepWindow(env: Env, url: URL): Promise<Response> {
  const date = url.searchParams.get("date");
  const tz = parseTzOffset(url);
  const bounds = date ? dayBounds(date, tz) : null;
  if (!bounds) return json({ error: "date must be YYYY-MM-DD" }, 400);
  // Sleep "belonging to" a date = the night ending that morning:
  // window is 18:00 the previous day through 18:00 on the date.
  const [dayStart] = bounds;
  const from = dayStart - 6 * 3_600_000; // 18:00 previous day
  const to = dayStart + 18 * 3_600_000; // 18:00 on the date

  const { results } = await env.DB.prepare(
    `SELECT uuid, value, start_ts, end_ts, source, device, metadata
     FROM samples WHERE type = 'sleepAnalysis' AND start_ts >= ? AND start_ts < ?
     ORDER BY start_ts ASC`
  )
    .bind(from, to)
    .all<{ uuid: string; value: number | null; start_ts: number; end_ts: number; source: string; device: string | null; metadata: string | null }>();

  const rows = results ?? [];
  // HealthKit sleepAnalysis category values: 0 inBed, 1 asleepUnspecified,
  // 2 awake, 3 asleepCore, 4 asleepDeep, 5 asleepREM.
  const ASLEEP = new Set([1, 3, 4, 5]);
  let asleepMs = 0;
  let inBedStart: number | null = null;
  let inBedEnd: number | null = null;
  for (const r of rows) {
    if (r.value !== null && ASLEEP.has(r.value)) asleepMs += r.end_ts - r.start_ts;
    inBedStart = inBedStart === null ? r.start_ts : Math.min(inBedStart, r.start_ts);
    inBedEnd = inBedEnd === null ? r.end_ts : Math.max(inBedEnd, r.end_ts);
  }

  return json({
    date,
    tz_offset: tz,
    window: { from, to },
    segment_count: rows.length,
    asleep_ms: asleepMs,
    asleep_hours: Math.round((asleepMs / 3_600_000) * 100) / 100,
    in_bed_start: inBedStart,
    in_bed_end: inBedEnd,
    segments: rows,
    value_legend:
      "sleepAnalysis values: 0=inBed 1=asleepUnspecified 2=awake 3=asleepCore 4=asleepDeep 5=asleepREM",
  });
}

async function handleActivitySummary(env: Env, url: URL): Promise<Response> {
  const { from, to } = parseRange(url);
  const tz = parseTzOffset(url);

  const days: Record<string, Record<string, unknown>> = {};
  for (const t of CUMULATIVE_DEDUPE_TYPES) {
    const totals = await cumulativeDayTotals(env.DB, t, from, to, tz);
    for (const [day, v] of totals) {
      days[day] = days[day] ?? { day };
      days[day][t] = { total: v.total, sample_count: v.n, source: v.source };
    }
  }

  const { results: exercise } = await env.DB.prepare(
    `SELECT ${dayExpr(tz)} AS day, SUM(value) AS total, COUNT(*) AS n
     FROM samples WHERE type = 'appleExerciseTime' AND start_ts >= ? AND start_ts < ?
     GROUP BY day`
  )
    .bind(from, to)
    .all<{ day: string; total: number; n: number }>();
  for (const r of exercise ?? []) {
    days[r.day] = days[r.day] ?? { day: r.day };
    days[r.day].appleExerciseTime = { total: r.total, sample_count: r.n };
  }

  const list = Object.values(days).sort((a, b) =>
    String(a.day).localeCompare(String(b.day))
  );
  return json({
    from,
    to,
    tz_offset: tz,
    day_count: list.length,
    days: list,
    dedupe_note:
      "stepCount and activeEnergyBurned prefer watch-sourced samples when watch and phone overlap on the same day.",
  });
}

async function handleSubjective(env: Env, url: URL): Promise<Response> {
  const { from, to } = parseRange(url);
  const limit = parseLimit(url);
  const { results } = await env.DB.prepare(
    `SELECT uuid, type, value, unit, start_ts, end_ts, source, metadata
     FROM samples WHERE type LIKE 'subjective.%' AND start_ts >= ? AND start_ts < ?
     ORDER BY start_ts DESC LIMIT ?`
  )
    .bind(from, to, limit)
    .all();
  return json({ from, to, count: results?.length ?? 0, samples: results ?? [] });
}

async function handlePatterns(env: Env, url: URL): Promise<Response> {
  const days = Math.min(Math.max(1, Math.trunc(Number(url.searchParams.get("days")) || 7)), 90);
  const tz = parseTzOffset(url);
  const to = Date.now();
  const from = to - days * 86_400_000;

  // Per-day averages for point metrics.
  const { results: avgRows } = await env.DB.prepare(
    `SELECT ${dayExpr(tz)} AS day, type, COUNT(*) AS n, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max
     FROM samples
     WHERE start_ts >= ? AND start_ts < ?
       AND type IN ('heartRateVariabilitySDNN','restingHeartRate','heartRate','respiratoryRate','oxygenSaturation')
     GROUP BY day, type ORDER BY day ASC`
  )
    .bind(from, to)
    .all<{ day: string; type: string; n: number; avg: number; min: number; max: number }>();

  // Per-day deduped cumulative totals.
  const cumulative: Record<string, unknown[]> = {};
  for (const t of CUMULATIVE_DEDUPE_TYPES) {
    const totals = await cumulativeDayTotals(env.DB, t, from, to, tz);
    cumulative[t] = [...totals.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, total: v.total, sample_count: v.n, source: v.source }));
  }

  return json({
    days,
    tz_offset: tz,
    from,
    to,
    daily_metrics: avgRows ?? [],
    daily_cumulative: cumulative,
    note: "Descriptive per-day aggregates only. No interpretation is applied.",
    dedupe_note:
      "stepCount and activeEnergyBurned prefer watch-sourced samples when watch and phone overlap on the same day.",
  });
}

// ---------------------------------------------------------------------------
// Ingest (guarded by INGEST_TOKEN)
// ---------------------------------------------------------------------------

async function handleIngest(request: Request, env: Env): Promise<Response> {
  let body: { schema_v?: number; samples?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (body.schema_v !== SCHEMA_V)
    return json({ error: `unsupported schema_v (want ${SCHEMA_V})` }, 400);
  if (!Array.isArray(body.samples) || body.samples.length === 0)
    return json({ error: "samples must be a non-empty array" }, 400);
  if (body.samples.length > MAX_BATCH)
    return json({ error: `batch too large (max ${MAX_BATCH})` }, 400);

  const rejected: { uuid: string | null; reason: string }[] = [];
  const valid: IncomingSample[] = [];
  for (const s of body.samples) {
    const reason = validateSample(s);
    if (reason)
      rejected.push({
        uuid: typeof (s as IncomingSample)?.uuid === "string" ? (s as IncomingSample).uuid : null,
        reason,
      });
    else valid.push(s as IncomingSample);
  }

  // Dedupe + insert. Idempotent: duplicates are success, retries are free.
  let accepted = 0;
  let duplicates = 0;
  if (valid.length > 0) {
    const now = Date.now();
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO samples
         (uuid, type, value, unit, start_ts, end_ts, source, device, metadata, schema_v, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const results = await env.DB.batch(
      valid.map((s) =>
        stmt.bind(
          s.uuid,
          s.type,
          s.value ?? null,
          s.unit ?? null,
          Math.trunc(s.start_ts),
          Math.trunc(s.end_ts),
          s.source,
          s.device ?? null,
          s.metadata ? JSON.stringify(s.metadata) : null,
          SCHEMA_V,
          now
        )
      )
    );
    for (const r of results) {
      const changes = (r.meta as { changes?: number }).changes ?? 0;
      if (changes > 0) accepted++;
      else duplicates++;
    }
  }

  return json({ accepted, duplicates, rejected });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const READ_ROUTES: Record<string, (env: Env, url: URL) => Promise<Response>> = {
  "/v1/query/status": (env) => handleStatus(env),
  "/v1/query/samples": handleSamples,
  "/v1/query/daily-summary": handleDailySummary,
  "/v1/query/sleep-window": handleSleepWindow,
  "/v1/query/activity-summary": handleActivitySummary,
  "/v1/query/subjective": handleSubjective,
  "/v1/query/patterns": handlePatterns,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Public health check — no auth, no payload details.
    if (url.pathname === "/v1/health" && request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n, MAX(received_at) AS last FROM samples"
      ).first<{ n: number; last: number | null }>();
      return json({ ok: true, samples: row?.n ?? 0, last_received_at: row?.last ?? null });
    }

    // Write plane.
    if (url.pathname === "/v1/ingest" && request.method === "POST") {
      if (!bearerMatches(request, env.INGEST_TOKEN))
        return json({ error: "unauthorized" }, 401);
      return handleIngest(request, env);
    }

    // Read plane — separate secret; the ingest token is NEVER valid here.
    const readHandler = READ_ROUTES[url.pathname];
    if (readHandler && request.method === "GET") {
      if (!bearerMatches(request, env.READ_TOKEN))
        return json({ error: "unauthorized" }, 401);
      return readHandler(env, url);
    }

    return json({ error: "not found" }, 404);
  },
};
