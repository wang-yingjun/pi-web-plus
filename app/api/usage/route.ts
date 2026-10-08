import { NextResponse } from "next/server";
import {
  aggregateUsage,
  isUsageGranularity,
  loadAllSessionUsage,
  UsageRangeTooLargeError,
} from "@/lib/usage-stats";

export const dynamic = "force-dynamic";

function parseTime(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Time-bucketed token usage and cost across every session file.
 *
 * GET /api/usage?granularity=hour|day|week|month&from=<ms>&to=<ms>
 *
 * `from`/`to` are inclusive epoch milliseconds. With no `from`, the earliest
 * recorded usage is the lower bound. The response is a contiguous, zero-filled
 * series so charts do not have to reindex gaps.
 */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const params = new URL(request.url).searchParams;

  const granularityParam = params.get("granularity") ?? "day";
  if (!isUsageGranularity(granularityParam)) {
    return NextResponse.json(
      { error: `granularity must be one of hour, day, week, month` },
      { status: 400, headers },
    );
  }

  const from = parseTime(params.get("from"));
  const to = parseTime(params.get("to"));
  if (from !== undefined && to !== undefined && from > to) {
    return NextResponse.json({ error: "from must not be after to" }, { status: 400, headers });
  }

  try {
    const sessions = await loadAllSessionUsage();
    const result = aggregateUsage(sessions, { granularity: granularityParam, from, to });
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof UsageRangeTooLargeError) {
      return NextResponse.json(
        { error: "Requested range is too large for this granularity", bucketCount: error.bucketCount },
        { status: 400, headers },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
