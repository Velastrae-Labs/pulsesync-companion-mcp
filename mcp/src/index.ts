#!/usr/bin/env node
// PulseSync Companion MCP — read-only access to your exported PulseSync data.
//
// Configuration (environment variables):
//   PULSESYNC_ENDPOINT   — base URL of your deployed Worker, e.g. https://pulsesync-worker.example.workers.dev
//   PULSESYNC_READ_TOKEN — the READ token (never the ingest/write token)
//
// This server can only READ. It holds no write credential, performs no
// writeback into PulseSync or HealthKit, and applies no medical
// interpretation. Every response carries provenance, the time range
// queried, sample counts, and an explicit uncertainty note when data is
// sparse.
//
// To the mind running this server: see llms.txt at the repo root.
// It was written for you.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ENDPOINT = (process.env.PULSESYNC_ENDPOINT ?? "").replace(/\/+$/, "");
const READ_TOKEN = process.env.PULSESYNC_READ_TOKEN ?? "";

if (!ENDPOINT || !READ_TOKEN) {
  console.error(
    "PulseSync Companion MCP: set PULSESYNC_ENDPOINT and PULSESYNC_READ_TOKEN environment variables. " +
      "See docs/ai-assistant-setup.md."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Response envelope — every tool result passes through here. It enforces:
//   • the time range that was actually queried
//   • provenance (which endpoint answered, data source description)
//   • sample count
//   • an uncertainty note when data is sparse
//   • a standing no-medical-advice guidance block
// ---------------------------------------------------------------------------

const SPARSE_THRESHOLD = 5;

const GUIDANCE =
  "This is descriptive personal-device data, not medical information. " +
  "Do not offer diagnosis, treatment, or medical advice based on it. " +
  "Do not claim one metric caused another; consumer sensors have known " +
  "accuracy limits and gaps. Describe what the data shows and its limits.";

interface EnvelopeOpts {
  tool: string;
  timeRange: { from?: number | string | null; to?: number | string | null; description: string };
  sampleCount: number;
  data: unknown;
  extraNotes?: string[];
}

function toIso(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return new Date(v).toISOString();
}

function responseEnvelope(opts: EnvelopeOpts) {
  const notes: string[] = [...(opts.extraNotes ?? [])];
  if (opts.sampleCount < SPARSE_THRESHOLD) {
    notes.push(
      `Sparse data: only ${opts.sampleCount} sample(s) in this range. ` +
        "Treat any summary as low-confidence; it may not represent the period."
    );
  }
  const envelope = {
    tool: opts.tool,
    time_range: {
      from: toIso(opts.timeRange.from),
      to: toIso(opts.timeRange.to),
      description: opts.timeRange.description,
    },
    provenance: {
      source: "PulseSync export store (user-owned Cloudflare Worker + D1)",
      endpoint: ENDPOINT,
      access: "read-only via READ token; no write credential present",
    },
    sample_count: opts.sampleCount,
    uncertainty_notes: notes,
    guidance: GUIDANCE,
    data: opts.data,
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `PulseSync Companion MCP error: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// HTTP helper — read plane only.
// ---------------------------------------------------------------------------

async function readApi(path: string, params: Record<string, string | number | undefined> = {}) {
  const url = new URL(`${ENDPOINT}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${READ_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`endpoint returned HTTP ${res.status} for ${path}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

function dateToMs(date: string | undefined, fallback: number): number {
  if (!date) return fallback;
  const t = Date.parse(date);
  return Number.isFinite(t) ? t : fallback;
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "pulsesync-companion",
  version: "1.0.0",
});

const tzOffsetParam = z
  .number()
  .int()
  .min(-840)
  .max(840)
  .optional()
  .describe("Your timezone offset in minutes east of UTC (e.g. -300 for US Eastern winter). Day boundaries default to UTC.");

server.registerTool(
  "pulsesync_status",
  {
    title: "PulseSync export status",
    description:
      "Overview of the exported data store: total samples, per-type counts, earliest/latest sample timestamps, last time data was received.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await readApi("/v1/query/status");
      const types = (data.types as { n: number }[]) ?? [];
      return responseEnvelope({
        tool: "pulsesync_status",
        timeRange: {
          from: data.earliest_ts as number | null,
          to: data.latest_ts as number | null,
          description: "full extent of the export store",
        },
        sampleCount: (data.samples as number) ?? 0,
        data,
        extraNotes: types.length === 0 ? ["No sample types found — the store may be empty or export may not be configured."] : [],
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

server.registerTool(
  "pulsesync_recent_samples",
  {
    title: "Recent raw samples",
    description:
      "Fetch raw exported samples, optionally filtered by type (e.g. heartRate, heartRateVariabilitySDNN, stepCount, sleepAnalysis, subjective.*) and time range.",
    inputSchema: {
      type: z.string().optional().describe("Sample type filter, e.g. 'heartRate'. Omit for all types."),
      from: z.string().optional().describe("Start of range, ISO 8601 (default: 24h ago)."),
      to: z.string().optional().describe("End of range, ISO 8601 (default: now)."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max samples to return (default 200)."),
    },
  },
  async ({ type, from, to, limit }) => {
    try {
      const now = Date.now();
      const fromMs = dateToMs(from, now - 86_400_000);
      const toMs = dateToMs(to, now);
      const data = await readApi("/v1/query/samples", { type, from: fromMs, to: toMs, limit });
      return responseEnvelope({
        tool: "pulsesync_recent_samples",
        timeRange: { from: fromMs, to: toMs, description: `raw samples${type ? ` of type ${type}` : ""}` },
        sampleCount: (data.count as number) ?? 0,
        data,
        extraNotes:
          ((data.count as number) ?? 0) >= (limit ?? 200)
            ? ["Result hit the limit — there may be more samples in this range."]
            : [],
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

server.registerTool(
  "pulsesync_daily_summary",
  {
    title: "Daily summary",
    description:
      "Aggregated metrics for one calendar day: heart rate stats, HRV, resting HR, SpO2, respiratory rate, wrist temperature, plus deduped step and energy totals and exercise minutes.",
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar day, YYYY-MM-DD."),
      tz_offset: tzOffsetParam,
    },
  },
  async ({ date, tz_offset }) => {
    try {
      const data = await readApi("/v1/query/daily-summary", { date, tz_offset });
      return responseEnvelope({
        tool: "pulsesync_daily_summary",
        timeRange: { from: data.from as number, to: data.to as number, description: `calendar day ${date}` },
        sampleCount: (data.total_samples as number) ?? 0,
        data,
        extraNotes: [String(data.dedupe_note ?? "")].filter(Boolean),
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

server.registerTool(
  "pulsesync_sleep_window",
  {
    title: "Sleep window",
    description:
      "Sleep segments for the night ending on the given date (window: 18:00 previous day to 18:00 on the date). Returns segments, total asleep time, and in-bed window.",
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The morning the sleep ended, YYYY-MM-DD."),
      tz_offset: tzOffsetParam,
    },
  },
  async ({ date, tz_offset }) => {
    try {
      const data = await readApi("/v1/query/sleep-window", { date, tz_offset });
      const win = data.window as { from: number; to: number };
      return responseEnvelope({
        tool: "pulsesync_sleep_window",
        timeRange: { from: win?.from, to: win?.to, description: `sleep night ending ${date}` },
        sampleCount: (data.segment_count as number) ?? 0,
        data,
        extraNotes: [
          "Sleep staging from consumer devices is an estimate, not a clinical sleep study.",
        ],
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

server.registerTool(
  "pulsesync_activity_summary",
  {
    title: "Activity summary",
    description:
      "Per-day step counts, active energy, and exercise minutes over a date range, with watch-over-phone dedupe for overlapping sources.",
    inputSchema: {
      from: z.string().describe("Start of range, ISO 8601 or YYYY-MM-DD."),
      to: z.string().describe("End of range, ISO 8601 or YYYY-MM-DD."),
      tz_offset: tzOffsetParam,
    },
  },
  async ({ from, to, tz_offset }) => {
    try {
      const fromMs = dateToMs(from, Date.now() - 7 * 86_400_000);
      const toMs = dateToMs(to, Date.now());
      const data = await readApi("/v1/query/activity-summary", { from: fromMs, to: toMs, tz_offset });
      const days = (data.days as unknown[]) ?? [];
      const sampleCount = days.reduce((s: number, d) => {
        const rec = d as Record<string, { sample_count?: number }>;
        return (
          s +
          (rec.stepCount?.sample_count ?? 0) +
          (rec.activeEnergyBurned?.sample_count ?? 0) +
          (rec.appleExerciseTime?.sample_count ?? 0)
        );
      }, 0);
      return responseEnvelope({
        tool: "pulsesync_activity_summary",
        timeRange: { from: fromMs, to: toMs, description: `activity across ${days.length} day(s)` },
        sampleCount,
        data,
        extraNotes: [String(data.dedupe_note ?? "")].filter(Boolean),
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

server.registerTool(
  "pulsesync_subjective_logs",
  {
    title: "Subjective logs",
    description:
      "Self-reported entries the user logged in PulseSync (types under the 'subjective.*' namespace, e.g. mood, energy, focus). These are the user's own words/ratings, not sensor data.",
    inputSchema: {
      from: z.string().optional().describe("Start of range, ISO 8601 (default: 7 days ago)."),
      to: z.string().optional().describe("End of range, ISO 8601 (default: now)."),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ from, to, limit }) => {
    try {
      const now = Date.now();
      const fromMs = dateToMs(from, now - 7 * 86_400_000);
      const toMs = dateToMs(to, now);
      const data = await readApi("/v1/query/subjective", { from: fromMs, to: toMs, limit });
      return responseEnvelope({
        tool: "pulsesync_subjective_logs",
        timeRange: { from: fromMs, to: toMs, description: "self-reported subjective entries" },
        sampleCount: (data.count as number) ?? 0,
        data,
        extraNotes: ["Subjective entries are self-reported by the user and reflect their own framing."],
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

server.registerTool(
  "pulsesync_patterns",
  {
    title: "Recent patterns",
    description:
      "Per-day descriptive aggregates over the last N days (HRV, resting HR, heart rate, respiratory rate, SpO2 averages; deduped steps and energy). Purely descriptive — no interpretation.",
    inputSchema: {
      days: z.number().int().min(1).max(90).optional().describe("Number of days to look back (default 7, max 90)."),
      tz_offset: tzOffsetParam,
    },
  },
  async ({ days, tz_offset }) => {
    try {
      const data = await readApi("/v1/query/patterns", { days, tz_offset });
      const metricRows = (data.daily_metrics as { n: number }[]) ?? [];
      const sampleCount = metricRows.reduce((s, r) => s + (r.n ?? 0), 0);
      return responseEnvelope({
        tool: "pulsesync_patterns",
        timeRange: { from: data.from as number, to: data.to as number, description: `last ${data.days} day(s)` },
        sampleCount,
        data,
        extraNotes: [
          "Day-to-day variation in consumer sensor data is normal. Do not infer causes from co-occurring changes.",
        ],
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

server.registerTool(
  "pulsesync_export_health",
  {
    title: "Export pipeline health",
    description:
      "Checks whether the export endpoint is up and when it last received data (uses the public /v1/health endpoint; no health data contents).",
    inputSchema: {},
  },
  async () => {
    try {
      const res = await fetch(`${ENDPOINT}/v1/health`);
      if (!res.ok) throw new Error(`endpoint returned HTTP ${res.status} for /v1/health`);
      const data = (await res.json()) as { ok: boolean; samples: number; last_received_at: number | null };
      const staleMs = data.last_received_at ? Date.now() - data.last_received_at : null;
      return responseEnvelope({
        tool: "pulsesync_export_health",
        timeRange: {
          from: null,
          to: data.last_received_at,
          description: "endpoint liveness and last received time",
        },
        sampleCount: data.samples ?? 0,
        data: {
          ...data,
          last_received_iso: toIso(data.last_received_at),
          hours_since_last_receive: staleMs === null ? null : Math.round((staleMs / 3_600_000) * 10) / 10,
        },
        extraNotes:
          staleMs !== null && staleMs > 24 * 3_600_000
            ? ["No data received in over 24 hours — the app's export may be paused or misconfigured."]
            : [],
      });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("PulseSync Companion MCP: connected (stdio, read-only)");
