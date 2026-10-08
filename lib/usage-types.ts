// Pure usage-statistics types shared by the server aggregator and the Usage
// panel. Kept free of node/fs imports so the client component can import these
// without pulling the session scanner into the browser bundle.

export type UsageGranularity = "hour" | "day" | "week" | "month";

export const USAGE_GRANULARITIES: readonly UsageGranularity[] = ["hour", "day", "week", "month"];

export function isUsageGranularity(value: unknown): value is UsageGranularity {
  return typeof value === "string" && (USAGE_GRANULARITIES as readonly string[]).includes(value);
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  /** Number of billed usage records (model calls, compaction, cache warming). */
  requests: number;
}

export interface UsageBucket extends UsageTotals {
  start: number;
  end: number;
  /** Distinct sessions with usage in this bucket. */
  sessions: number;
}

export interface UsageBreakdown extends UsageTotals {
  provider: string;
  model: string;
}

export interface UsageStatsResult {
  granularity: UsageGranularity;
  from: number;
  to: number;
  generatedAt: number;
  totals: UsageTotals;
  buckets: UsageBucket[];
  models: UsageBreakdown[];
  providers: UsageBreakdown[];
  sessionCount: number;
}

/** One billed usage record, pre-aggregated by (hour, provider, model) per file. */
export interface UsageRecord {
  t: number;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests: number;
}

export interface SessionUsage {
  sessionId: string;
  records: UsageRecord[];
}
