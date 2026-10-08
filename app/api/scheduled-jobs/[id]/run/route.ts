import { NextResponse } from "next/server";
import { getScheduledJob } from "@/lib/scheduled-jobs";
import { isScheduledJobRunning, runScheduledJob } from "@/lib/scheduled-job-runner";

export const dynamic = "force-dynamic";

// POST /api/scheduled-jobs/[id]/run - start a job immediately.
// The run can take minutes, so this returns as soon as it is queued; the panel
// polls the job to follow progress.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getScheduledJob(id)) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (isScheduledJobRunning(id)) return NextResponse.json({ error: "Job is already running" }, { status: 409 });
  void runScheduledJob(id, "manual").catch((error) => {
    console.error("[pi-web] manual scheduled job run failed:", error instanceof Error ? error.message : error);
  });
  return NextResponse.json({ ok: true, started: true }, { status: 202 });
}
