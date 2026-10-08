// Token usage statistics across every session file.
//
// Pi records billed usage per assistant message (plus tool-result, compaction,
// branch-summary and cache-warm entries) with a timestamp, so time-bucketed
// totals can be reconstructed from `~/.pi/agent/sessions/**/*.jsonl`. Nothing
// in pi aggregates by hour/day/week/month itself; this module is that missing
// layer for the /api/usage route and the Usage panel.
//
// Files are parsed once and cached by (size, mtimeMs), mirroring
// lib/session-list-scanner.ts: only changed files are re-read on later
// requests. Parsing is streaming so a large session never lands in memory as a
// single buffer, and records are pre-aggregated by (hour, provider, model) to
// keep the cache small.

import { createReadStream, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  SessionUsage,
  UsageBreakdown,
  UsageBucket,
  UsageGranularity,
  UsageRecord,
  UsageStatsResult,
  UsageTotals,
} from "./usage-types";

export type {
  SessionUsage,
  UsageBreakdown,
  UsageBucket,
  UsageGranularity,
  UsageRecord,
  UsageStatsResult,
  UsageTotals,
} from "./usage-types";
export { isUsageGranularity, USAGE_GRANULARITIES } from "./usage-types";

/** Raised when a range would render more buckets than the caller allows. */
export class UsageRangeTooLargeError extends Error {
  constructor(public readonly bucketCount: number) {
    super(`Range spans ${bucketCount} buckets`);
    this.name = "UsageRangeTooLargeError";
  }
}

const UNKNOWN = "unknown";

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 };
}

function addInto(totals: UsageTotals, record: Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "requests">): void {
  totals.input += record.input;
  totals.output += record.output;
  totals.cacheRead += record.cacheRead;
  totals.cacheWrite += record.cacheWrite;
  totals.cost += record.cost;
  totals.requests += record.requests;
}

function withTotal(totals: UsageTotals): UsageTotals {
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}

/**
 * Start of the bucket containing `ts`, in the server's local timezone (the
 * browser is normally the same machine for a 127.0.0.1 web UI). Weeks start on
 * Monday, matching the way most users read a work-week.
 */
export function startOfBucket(ts: number, granularity: UsageGranularity): number {
  const date = new Date(ts);
  switch (granularity) {
    case "hour":
      date.setMinutes(0, 0, 0);
      return date.getTime();
    case "day":
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    case "week": {
      date.setHours(0, 0, 0, 0);
      const sinceMonday = (date.getDay() + 6) % 7;
      date.setDate(date.getDate() - sinceMonday);
      return date.getTime();
    }
    case "month":
      date.setHours(0, 0, 0, 0);
      date.setDate(1);
      return date.getTime();
  }
}

/** Start of the bucket after the one starting at `start`. */
export function nextBucketStart(start: number, granularity: UsageGranularity): number {
  const date = new Date(start);
  switch (granularity) {
    case "hour":
      date.setHours(date.getHours() + 1);
      return date.getTime();
    case "day":
      date.setDate(date.getDate() + 1);
      return date.getTime();
    case "week":
      date.setDate(date.getDate() + 7);
      return date.getTime();
    case "month":
      date.setMonth(date.getMonth() + 1);
      return date.getTime();
  }
}

/** Inclusive bucket starts covering [from, to]; throws past `maxBuckets`. */
export function bucketStarts(from: number, to: number, granularity: UsageGranularity, maxBuckets: number): number[] {
  const starts: number[] = [];
  let cursor = startOfBucket(from, granularity);
  const last = startOfBucket(to, granularity);
  while (cursor <= last && starts.length <= maxBuckets) {
    starts.push(cursor);
    cursor = nextBucketStart(cursor, granularity);
  }
  if (starts.length > maxBuckets) throw new UsageRangeTooLargeError(starts.length);
  return starts;
}

export interface AggregateUsageOptions {
  granularity: UsageGranularity;
  /** Inclusive lower bound. Defaults to the earliest record. */
  from?: number;
  /** Inclusive upper bound. Defaults to `now`. */
  to?: number;
  maxBuckets?: number;
  now?: number;
}

export const DEFAULT_MAX_BUCKETS = 1000;

/**
 * Bucket every record into a contiguous, zero-filled series. Pure so the shape
 * can be tested without touching the filesystem.
 */
export function aggregateUsage(
  sessions: readonly SessionUsage[],
  options: AggregateUsageOptions,
): UsageStatsResult {
  const { granularity } = options;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const now = options.now ?? Date.now();

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    for (const record of session.records) {
      if (!Number.isFinite(record.t)) continue;
      if (record.t < min) min = record.t;
      if (record.t > max) max = record.t;
    }
  }

  const from = Number.isFinite(options.from) ? (options.from as number) : Number.isFinite(min) ? min : now;
  const to = Number.isFinite(options.to) ? (options.to as number) : now;
  const effectiveTo = to < from ? from : to;

  const starts = bucketStarts(from, effectiveTo, granularity, maxBuckets);
  const index = new Map<number, number>();
  starts.forEach((start, position) => index.set(start, position));

  const buckets: UsageBucket[] = starts.map((start) => ({
    start,
    end: nextBucketStart(start, granularity),
    ...emptyTotals(),
    sessions: 0,
  }));
  const bucketSessions = starts.map(() => new Set<string>());

  const totals = emptyTotals();
  const models = new Map<string, UsageBreakdown>();
  const providers = new Map<string, UsageBreakdown>();
  const allSessions = new Set<string>();

  for (const session of sessions) {
    for (const record of session.records) {
      if (!Number.isFinite(record.t)) continue;
      if (record.t < from || record.t > effectiveTo) continue;

      allSessions.add(session.sessionId);
      addInto(totals, record);

      const position = index.get(startOfBucket(record.t, granularity));
      if (position !== undefined) {
        const bucket = buckets[position];
        addInto(bucket, record);
        bucketSessions[position].add(session.sessionId);
      }

      const modelKey = `${record.provider}\u0000${record.model}`;
      const model = models.get(modelKey) ?? { provider: record.provider, model: record.model, ...emptyTotals() };
      addInto(model, record);
      models.set(modelKey, model);

      const provider = providers.get(record.provider) ?? { provider: record.provider, model: "", ...emptyTotals() };
      addInto(provider, record);
      providers.set(record.provider, provider);
    }
  }

  for (const bucket of buckets) {
    bucket.total = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
  }
  for (const entry of models.values()) withTotal(entry);
  for (const entry of providers.values()) withTotal(entry);
  withTotal(totals);

  const byTotal = (a: UsageBreakdown, b: UsageBreakdown) => b.total - a.total || b.cost - a.cost;

  return {
    granularity,
    from,
    to: effectiveTo,
    generatedAt: Date.now(),
    totals,
    buckets: buckets.map((bucket, position) => ({ ...bucket, sessions: bucketSessions[position].size })),
    models: [...models.values()].sort(byTotal),
    providers: [...providers.values()].sort(byTotal),
    sessionCount: allSessions.size,
  };
}

// ---------------------------------------------------------------------------
// Session-file scanning + per-file cache (survives hot reload on globalThis).
// ---------------------------------------------------------------------------

interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

interface FileUsageCacheEntry {
  fingerprint: FileFingerprint;
  sessionId: string;
  records: UsageRecord[];
}

declare global {
  var __piWebUsageFileCache: Map<string, FileUsageCacheEntry> | undefined;
  var __piWebUsageBuild: Promise<SessionUsage[]> | undefined;
}

function getCache(): Map<string, FileUsageCacheEntry> {
  if (!globalThis.__piWebUsageFileCache) globalThis.__piWebUsageFileCache = new Map();
  return globalThis.__piWebUsageFileCache;
}

function fingerprintOf(fingerprint: FileFingerprint): string {
  return `${fingerprint.size}:${fingerprint.mtimeMs}`;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface RawUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
}

function normalizeUsage(raw: RawUsage | undefined): Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite" | "cost"> | null {
  if (!raw || typeof raw !== "object") return null;
  const input = numberOrZero(raw.input);
  const output = numberOrZero(raw.output);
  const cacheRead = numberOrZero(raw.cacheRead);
  const cacheWrite = numberOrZero(raw.cacheWrite);
  const cost = numberOrZero(raw.cost?.total)
    || numberOrZero(raw.cost?.input) + numberOrZero(raw.cost?.output) + numberOrZero(raw.cost?.cacheRead) + numberOrZero(raw.cost?.cacheWrite);
  if (input + output + cacheRead + cacheWrite === 0 && cost === 0) return null;
  return { input, output, cacheRead, cacheWrite, cost };
}

function entryTime(entry: Record<string, unknown>): number | undefined {
  const message = entry.message as Record<string, unknown> | undefined;
  if (message && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Pull every billed usage record out of one parsed session entry. */
function recordsFromEntry(entry: Record<string, unknown>): UsageRecord[] {
  const type = entry.type;
  let rawUsage: RawUsage | undefined;
  let provider = UNKNOWN;
  let model = UNKNOWN;

  if (type === "message") {
    const message = entry.message as Record<string, unknown> | undefined;
    const role = message?.role;
    if (!message || (role !== "assistant" && role !== "toolResult")) return [];
    rawUsage = message.usage as RawUsage | undefined;
    provider = stringOr(message.provider, UNKNOWN);
    model = stringOr(message.model, UNKNOWN);
  } else if (type === "usage" || type === "compaction" || type === "branch_summary") {
    rawUsage = entry.usage as RawUsage | undefined;
    provider = stringOr(entry.provider, UNKNOWN);
    model = stringOr(entry.model, UNKNOWN);
  } else {
    return [];
  }

  const usage = normalizeUsage(rawUsage);
  if (!usage) return [];
  const time = entryTime(entry);
  if (time === undefined) return [];
  return [{ t: time, provider, model, ...usage, requests: 1 }];
}

interface ParsedSessionFile {
  sessionId: string;
  records: UsageRecord[];
}

async function parseSessionFile(filePath: string, fallbackId: string): Promise<ParsedSessionFile> {
  const totals = new Map<string, UsageRecord>();
  let sessionId: string | undefined;

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "session") {
      sessionId = stringOr(entry.id, fallbackId);
      continue;
    }
    for (const record of recordsFromEntry(entry)) {
      // Pre-aggregate by hour + provider + model so the cache stays compact.
      const key = `${startOfBucket(record.t, "hour")}\u0000${record.provider}\u0000${record.model}`;
      const existing = totals.get(key);
      if (existing) {
        existing.input += record.input;
        existing.output += record.output;
        existing.cacheRead += record.cacheRead;
        existing.cacheWrite += record.cacheWrite;
        existing.cost += record.cost;
        existing.requests += record.requests;
      } else {
        totals.set(key, { ...record, t: startOfBucket(record.t, "hour") });
      }
    }
  }

  return { sessionId: sessionId ?? fallbackId, records: [...totals.values()] };
}

async function enumerateSessionFiles(sessionsDir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dirPath = join(sessionsDir, entry.name);
    try {
      for (const file of await readdir(dirPath)) {
        if (file.endsWith(".jsonl")) files.push(join(dirPath, file));
      }
    } catch {
      // Unreadable project dir: treat as absent.
    }
  }
  return files;
}

const MAX_CONCURRENT_PARSES = 8;

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const inFlight = new Set<Promise<void>>();
  while (next < items.length || inFlight.size > 0) {
    while (next < items.length && inFlight.size < MAX_CONCURRENT_PARSES) {
      const item = items[next++];
      const task = worker(item).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
}

async function buildAllSessions(): Promise<SessionUsage[]> {
  const sessionsDir = join(getAgentDir(), "sessions");
  const files = await enumerateSessionFiles(sessionsDir);
  const cache = getCache();
  const present = new Set(files);
  for (const known of cache.keys()) {
    if (!present.has(known)) cache.delete(known);
  }

  const changed: Array<{ filePath: string; fingerprint: FileFingerprint }> = [];
  const results: FileUsageCacheEntry[] = [];

  for (const filePath of files) {
    let fingerprint: FileFingerprint;
    try {
      const info = statSync(filePath);
      fingerprint = { size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      cache.delete(filePath);
      continue;
    }
    const cached = cache.get(filePath);
    if (cached && fingerprintOf(cached.fingerprint) === fingerprintOf(fingerprint)) {
      results.push(cached);
      continue;
    }
    changed.push({ filePath, fingerprint });
  }

  const parsed = new Map<string, FileUsageCacheEntry>();
  await runPool(changed, async ({ filePath, fingerprint }) => {
    try {
      const fallbackId = filePath.replace(/^.*_/, "").replace(/\.jsonl$/, "");
      const { sessionId, records } = await parseSessionFile(filePath, fallbackId);
      const entry = { fingerprint, sessionId, records };
      cache.set(filePath, entry);
      parsed.set(filePath, entry);
    } catch {
      // A file that disappears or is half-written is skipped, not fatal.
    }
  });

  for (const item of changed) {
    const entry = parsed.get(item.filePath);
    if (entry) results.push(entry);
  }

  return results.map((entry) => ({ sessionId: entry.sessionId, records: entry.records }));
}

/**
 * Every session's usage records, reusing cached parses for unchanged files.
 * Concurrent callers share one build.
 */
export function loadAllSessionUsage(): Promise<SessionUsage[]> {
  if (globalThis.__piWebUsageBuild) return globalThis.__piWebUsageBuild;
  const build = buildAllSessions().finally(() => {
    if (globalThis.__piWebUsageBuild === build) globalThis.__piWebUsageBuild = undefined;
  });
  globalThis.__piWebUsageBuild = build;
  return build;
}

/** Test seam: drop cached parses and any in-flight build. */
export function resetUsageStatsCacheForTests(): void {
  globalThis.__piWebUsageFileCache = undefined;
  globalThis.__piWebUsageBuild = undefined;
}
