import { NextResponse } from "next/server";
import {
  getScheduledJob,
  mutateScheduledJobsState,
  normalizeJobInput,
  refreshNextRun,
  ScheduleValidationError,
} from "@/lib/scheduled-jobs";

export const dynamic = "force-dynamic";

// GET /api/scheduled-jobs/[id] - one job with its run history.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getScheduledJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}

// PATCH /api/scheduled-jobs/[id] - update fields; omitted fields keep their value.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as Record<string, unknown>;
    const updated = await mutateScheduledJobsState((state) => {
      const job = state.jobs.find((entry) => entry.id === id);
      if (!job) return null;
      const input = normalizeJobInput({
        name: body.name ?? job.name,
        prompt: body.prompt ?? job.prompt,
        schedule: body.schedule ?? job.schedule,
        enabled: body.enabled ?? job.enabled,
        cwd: body.cwd !== undefined ? body.cwd : job.cwd,
        model: body.model !== undefined ? body.model : job.model,
      });
      job.name = input.name;
      job.prompt = input.prompt;
      job.schedule = input.schedule;
      job.enabled = input.enabled;
      job.cwd = input.cwd;
      job.model = input.model;
      refreshNextRun(job);
      return job;
    });
    if (!updated) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json({ job: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof ScheduleValidationError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

// DELETE /api/scheduled-jobs/[id] - remove a job and its run history.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const removed = await mutateScheduledJobsState((state) => {
    const index = state.jobs.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    state.jobs.splice(index, 1);
    return true;
  });
  if (!removed) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
