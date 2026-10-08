import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const shared = await createJiti(import.meta.url).import("./scheduled-jobs-shared.ts");
const store = await createJiti(import.meta.url).import("./scheduled-jobs.ts");

const {
  computeNextRun,
  describeSchedule,
  parseCronExpression,
  validateSchedule,
  normalizeJobInput,
  ScheduleValidationError,
  pushJobRun,
  completeJobRun,
} = shared;

const {
  createScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  mutateScheduledJobsState,
  readScheduledJobsState,
  writeScheduledJobsState,
} = store;

test("validates daily, weekly, interval and cron schedules", () => {
  assert.deepEqual(validateSchedule({ type: "daily", time: "8:05" }), { type: "daily", time: "08:05" });
  assert.deepEqual(
    validateSchedule({ type: "weekly", weekdays: [5, 1, 1], time: "23:59" }),
    { type: "weekly", weekdays: [1, 5], time: "23:59" },
  );
  assert.deepEqual(validateSchedule({ type: "interval", everyMinutes: 30 }), { type: "interval", everyMinutes: 30 });
  assert.deepEqual(validateSchedule({ type: "cron", expression: "0 8 * * 1-5" }), { type: "cron", expression: "0 8 * * 1-5" });

  assert.throws(() => validateSchedule({ type: "daily", time: "25:00" }), ScheduleValidationError);
  assert.throws(() => validateSchedule({ type: "interval", everyMinutes: 1 }), ScheduleValidationError);
  assert.throws(() => validateSchedule({ type: "weekly", weekdays: [], time: "08:00" }), ScheduleValidationError);
  assert.throws(() => validateSchedule({ type: "cron", expression: "0 8 * *" }), ScheduleValidationError);
});

test("parses a five-field cron expression including ranges and steps", () => {
  const parsed = parseCronExpression("*/15 8-9 * * 1-5");
  assert.ok(parsed);
  assert.deepEqual([...parsed.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...parsed.hours].sort((a, b) => a - b), [8, 9]);
  assert.deepEqual([...parsed.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(parseCronExpression("nope"), null);
  assert.equal(parseCronExpression("60 0 * * *"), null);
});

test("computes the next run for each schedule kind", () => {
  const from = new Date(2024, 0, 1, 7, 30, 0); // Monday 2024-01-01 07:30 local

  assert.deepEqual(
    computeNextRun({ type: "daily", time: "08:00" }, from),
    new Date(2024, 0, 1, 8, 0, 0),
  );
  // 08:00 already passed, so it rolls to the next day.
  assert.deepEqual(
    computeNextRun({ type: "daily", time: "08:00" }, new Date(2024, 0, 1, 9, 0, 0)),
    new Date(2024, 0, 2, 8, 0, 0),
  );
  // Weekly Mon/Wed/Fri picks the same Monday.
  assert.deepEqual(
    computeNextRun({ type: "weekly", weekdays: [1, 3, 5], time: "09:15" }, from),
    new Date(2024, 0, 1, 9, 15, 0),
  );
  // Weekly Sunday only goes to the following Sunday.
  assert.deepEqual(
    computeNextRun({ type: "weekly", weekdays: [0], time: "09:15" }, from),
    new Date(2024, 0, 7, 9, 15, 0),
  );
  assert.deepEqual(
    computeNextRun({ type: "interval", everyMinutes: 30 }, from),
    new Date(2024, 0, 1, 8, 0, 0),
  );
  assert.deepEqual(
    computeNextRun({ type: "hourly", minute: 45 }, from),
    new Date(2024, 0, 1, 7, 45, 0),
  );
  assert.deepEqual(
    computeNextRun({ type: "cron", expression: "0 8 * * *" }, from),
    new Date(2024, 0, 1, 8, 0, 0),
  );
});

test("describes schedules for the sidebar", () => {
  assert.equal(describeSchedule({ type: "daily", time: "08:00" }), "Every day at 08:00");
  assert.equal(describeSchedule({ type: "interval", everyMinutes: 120 }), "Every 2 hours");
  assert.equal(describeSchedule({ type: "interval", everyMinutes: 30 }), "Every 30 minutes");
  assert.equal(describeSchedule({ type: "hourly", minute: 5 }), "Every hour at :05");
  assert.equal(describeSchedule({ type: "cron", expression: "0 8 * * *" }), "Cron: 0 8 * * *");
});

test("normalizes job input and rejects incomplete payloads", () => {
  const input = normalizeJobInput({
    name: "  Digest  ",
    prompt: "  Summarize AI news  ",
    schedule: { type: "daily", time: "08:00" },
    cwd: "",
  });
  assert.equal(input.name, "Digest");
  assert.equal(input.prompt, "Summarize AI news");
  assert.equal(input.enabled, true);
  assert.equal(input.cwd, null);

  assert.throws(() => normalizeJobInput({ name: "", prompt: "x", schedule: { type: "daily", time: "08:00" } }), ScheduleValidationError);
  assert.throws(() => normalizeJobInput({ name: "x", prompt: " ", schedule: { type: "daily", time: "08:00" } }), ScheduleValidationError);
});

test("tracks run history and consecutive failures", () => {
  const job = createScheduledJob({
    name: "Digest",
    prompt: "go",
    schedule: { type: "daily", time: "08:00" },
    enabled: true,
    cwd: null,
  });
  assert.ok(job.nextRunAt);
  const run = {
    id: "run-1",
    startedAt: "2024-01-01T08:00:00.000Z",
    finishedAt: null,
    status: "running",
    trigger: "schedule",
    sessionId: null,
    model: null,
    summary: "",
    error: null,
  };
  pushJobRun(job, run);
  assert.equal(job.runs.length, 1);
  assert.equal(job.lastStatus, "running");

  completeJobRun(job, "run-1", { status: "error", error: "boom", finishedAt: "2024-01-01T08:01:00.000Z" });
  assert.equal(job.lastStatus, "error");
  assert.equal(job.consecutiveFailures, 1);
  assert.equal(job.runs[0].error, "boom");

  completeJobRun(job, "run-1", { status: "success" });
  assert.equal(job.consecutiveFailures, 0);
});

test("persists jobs to disk and reads them back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-jobs-"));
  const path = join(dir, "scheduled-jobs.json");
  try {
    assert.deepEqual(readScheduledJobsState(path).jobs, []);

    const created = await mutateScheduledJobsState((state) => {
      const job = createScheduledJob({
        name: "Topic news digest",
        prompt: "Search the web...",
        schedule: { type: "daily", time: "08:00" },
        enabled: true,
        cwd: null,
      });
      state.jobs.push(job);
      return job;
    }, path);

    const loaded = listScheduledJobs(path);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, created.id);
    assert.equal(loaded[0].name, "Topic news digest");
    assert.equal(getScheduledJob(created.id, path).schedule.time, "08:00");

    await mutateScheduledJobsState((state) => {
      state.jobs[0].enabled = false;
      state.jobs[0].nextRunAt = null;
    }, path);
    assert.equal(listScheduledJobs(path)[0].enabled, false);

    // A corrupt file must not throw; it reads as empty.
    writeScheduledJobsState({ version: 1, jobs: [] }, path);
    assert.deepEqual(listScheduledJobs(path), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
