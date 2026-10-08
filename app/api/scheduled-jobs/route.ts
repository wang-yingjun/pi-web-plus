import { NextResponse } from "next/server";
import {
  createScheduledJob,
  listScheduledJobs,
  mutateScheduledJobsState,
  normalizeJobInput,
  ScheduleValidationError,
} from "@/lib/scheduled-jobs";

export const dynamic = "force-dynamic";

// GET /api/scheduled-jobs - list every scheduled job with its run history.
export async function GET() {
  try {
    return NextResponse.json({ jobs: listScheduledJobs() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// POST /api/scheduled-jobs - create a job. Body: { name, prompt, schedule, enabled?, cwd? }
export async function POST(req: Request) {
  try {
    const input = normalizeJobInput(await req.json());
    const job = await mutateScheduledJobsState((state) => {
      const created = createScheduledJob(input);
      state.jobs.push(created);
      return created;
    });
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof ScheduleValidationError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
