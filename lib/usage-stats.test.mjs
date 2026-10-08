import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The bucket math is local-time based; pin the timezone so day/week/month
// boundaries are deterministic regardless of where the suite runs.
process.env.TZ = "UTC";

const jiti = createJiti(import.meta.url);
const {
  aggregateUsage,
  startOfBucket,
  nextBucketStart,
  bucketStarts,
  isUsageGranularity,
  UsageRangeTooLargeError,
  DEFAULT_MAX_BUCKETS,
} = await jiti.import("./usage-stats.ts");

function rec(over = {}) {
  return {
    t: 0,
    provider: "openai",
    model: "gpt",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    requests: 1,
    ...over,
  };
}

test("recognizes granularities", () => {
  assert.equal(isUsageGranularity("hour"), true);
  assert.equal(isUsageGranularity("month"), true);
  assert.equal(isUsageGranularity("year"), false);
  assert.equal(isUsageGranularity(null), false);
});

test("startOfBucket snaps to hour, day, Monday week and month", () => {
  const jan7 = Date.parse("2026-01-07T12:34:56.000Z");
  assert.equal(startOfBucket(jan7, "hour"), Date.parse("2026-01-07T12:00:00.000Z"));
  assert.equal(startOfBucket(jan7, "day"), Date.parse("2026-01-07T00:00:00.000Z"));
  assert.equal(startOfBucket(jan7, "week"), Date.parse("2026-01-05T00:00:00.000Z"));
  assert.equal(startOfBucket(jan7, "month"), Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(startOfBucket(Date.parse("2026-01-31T23:00:00Z"), "month"), Date.parse("2026-01-01T00:00:00Z"));
});

test("nextBucketStart advances one calendar unit", () => {
  assert.equal(nextBucketStart(Date.parse("2026-01-07T12:00:00Z"), "hour"), Date.parse("2026-01-07T13:00:00Z"));
  assert.equal(nextBucketStart(Date.parse("2026-01-07T00:00:00Z"), "day"), Date.parse("2026-01-08T00:00:00Z"));
  assert.equal(nextBucketStart(Date.parse("2026-01-05T00:00:00Z"), "week"), Date.parse("2026-01-12T00:00:00Z"));
  // Month lengths differ, so this is calendar arithmetic, not a fixed stride.
  assert.equal(nextBucketStart(Date.parse("2026-01-01T00:00:00Z"), "month"), Date.parse("2026-02-01T00:00:00Z"));
});

test("bucketStarts spans the range inclusive and guards the cap", () => {
  const starts = bucketStarts(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-03T22:00:00Z"), "day", 10);
  assert.equal(starts.length, 3);
  assert.throws(
    () => bucketStarts(Date.parse("2025-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"), "hour", 100),
    UsageRangeTooLargeError,
  );
  assert.equal(DEFAULT_MAX_BUCKETS, 1000);
});

test("aggregates usage into contiguous buckets and zero-fills gaps", () => {
  const sessions = [
    { sessionId: "a", records: [rec({ t: Date.parse("2026-01-01T10:00:00Z"), input: 100, output: 10, cost: 1 })] },
    { sessionId: "b", records: [rec({ t: Date.parse("2026-01-03T05:00:00Z"), input: 50, output: 5, cost: 0.5 })] },
  ];
  const result = aggregateUsage(sessions, {
    granularity: "day",
    from: Date.parse("2026-01-01T00:00:00Z"),
    to: Date.parse("2026-01-03T23:00:00Z"),
    now: 0,
  });

  assert.equal(result.buckets.length, 3);
  assert.equal(result.buckets[0].total, 110);
  assert.equal(result.buckets[1].total, 0);
  assert.equal(result.buckets[2].total, 55);
  assert.equal(result.buckets[0].sessions, 1);
  assert.equal(result.buckets[2].sessions, 1);
  assert.equal(result.totals.total, 165);
  assert.equal(result.totals.cost, 1.5);
  assert.equal(result.totals.requests, 2);
  assert.equal(result.sessionCount, 2);
});

test("splits per provider and per provider/model, sorted by volume", () => {
  const sessions = [
    {
      sessionId: "a",
      records: [
        rec({ t: 1, provider: "openai", model: "gpt", input: 10 }),
        rec({ t: 2, provider: "anthropic", model: "claude", input: 100 }),
        rec({ t: 3, provider: "anthropic", model: "claude", input: 50 }),
      ],
    },
  ];
  const result = aggregateUsage(sessions, {
    granularity: "day",
    from: 0,
    to: 10 * 24 * 60 * 60 * 1000,
    now: 0,
  });
  assert.deepEqual(result.providers.map((p) => [p.provider, p.total]), [["anthropic", 150], ["openai", 10]]);
  assert.deepEqual(result.models.map((m) => [m.provider, m.model, m.total]), [
    ["anthropic", "claude", 150],
    ["openai", "gpt", 10],
  ]);
});

test("defaults an open range to the recorded span", () => {
  const sessions = [
    {
      sessionId: "a",
      records: [
        rec({ t: Date.parse("2026-02-01T00:00:00Z"), input: 5 }),
        rec({ t: Date.parse("2026-02-03T00:00:00Z"), input: 7 }),
      ],
    },
  ];
  const result = aggregateUsage(sessions, { granularity: "day", now: Date.parse("2026-02-05T00:00:00Z") });
  assert.equal(result.from, Date.parse("2026-02-01T00:00:00Z"));
  assert.equal(result.to, Date.parse("2026-02-05T00:00:00Z"));
  assert.equal(result.buckets.length, 5);
  assert.equal(result.totals.input, 12);
});

test("returns an empty series when there is no usage yet", () => {
  const result = aggregateUsage([], { granularity: "day", now: Date.parse("2026-02-05T12:00:00Z") });
  assert.equal(result.buckets.length, 1);
  assert.equal(result.totals.total, 0);
  assert.equal(result.sessionCount, 0);
});
