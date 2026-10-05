/**
 * Client-safe scheduled-job primitives: types, schedule validation, next-run
 * math and display helpers. The on-disk store lives in `scheduled-jobs.ts`,
 * which imports everything here so the panel never pulls in `node:fs`.
 */

export type JobSchedule =
  | { type: "interval"; everyMinutes: number }
  | { type: "hourly"; minute: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; weekdays: number[]; time: string }
  | { type: "cron"; expression: string };

export type JobRunStatus = "running" | "success" | "error";

export interface JobRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: JobRunStatus;
  trigger: "schedule" | "manual";
  sessionId: string | null;
  model: { provider: string; modelId: string } | null;
  /** Final assistant text from the run, trimmed for storage. */
  summary: string;
  error: string | null;
}

export interface ScheduledJob {
  id: string;
  name: string;
  prompt: string;
  schedule: JobSchedule;
  enabled: boolean;
  /** Working directory for the run. null uses Pi Web's default project. */
  cwd: string | null;
  /** Model override. null uses Pi Web's default model. */
  model: { provider: string; modelId: string } | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: JobRunStatus | null;
  consecutiveFailures: number;
}

export interface ScheduledJobWithRuns extends ScheduledJob {
  runs: JobRun[];
}

export interface ScheduledJobsState {
  version: 1;
  jobs: ScheduledJobWithRuns[];
}

export const MAX_RUN_HISTORY = 20;
export const MAX_SUMMARY_CHARS = 6000;
export const MAX_PROMPT_CHARS = 20000;
export const MAX_NAME_CHARS = 120;
export const MIN_INTERVAL_MINUTES = 5;

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Parse "HH:MM" (24h) into minutes since midnight, or null when invalid. */
export function parseTimeOfDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatTimeOfDay(minutesSinceMidnight: number): string {
  const hours = Math.floor(minutesSinceMidnight / 60);
  const minutes = minutesSinceMidnight % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function startOfMinute(date: Date): Date {
  const next = new Date(date);
  next.setSeconds(0, 0);
  return next;
}

function atTimeOfDay(base: Date, minutesSinceMidnight: number, dayOffset: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(Math.floor(minutesSinceMidnight / 60), minutesSinceMidnight % 60, 0, 0);
  return next;
}

// ---------------------------------------------------------------------------
// Schedule parsing / validation
// ---------------------------------------------------------------------------

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = stepPart === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

export function parseCronExpression(expression: string): ParsedCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  // Cron accepts 0-7 with both 0 and 7 meaning Sunday.
  const rawDow = parseCronField(fields[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDow) return null;
  const daysOfWeek = new Set<number>();
  for (const day of rawDow) daysOfWeek.add(day === 7 ? 0 : day);
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

export function validateSchedule(value: unknown): JobSchedule {
  if (!isRecord(value)) throw new ScheduleValidationError("Schedule is required");
  const type = value.type;
  switch (type) {
    case "interval": {
      const everyMinutes = Number(value.everyMinutes);
      if (!Number.isInteger(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES || everyMinutes > 60 * 24 * 7) {
        throw new ScheduleValidationError(`Interval must be between ${MIN_INTERVAL_MINUTES} minutes and 7 days`);
      }
      return { type: "interval", everyMinutes };
    }
    case "hourly": {
      const minute = Number(value.minute);
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new ScheduleValidationError("Minute must be between 0 and 59");
      }
      return { type: "hourly", minute };
    }
    case "daily": {
      const minutes = parseTimeOfDay(value.time);
      if (minutes === null) throw new ScheduleValidationError("Time must be formatted as HH:MM");
      return { type: "daily", time: formatTimeOfDay(minutes) };
    }
    case "weekly": {
      const minutes = parseTimeOfDay(value.time);
      if (minutes === null) throw new ScheduleValidationError("Time must be formatted as HH:MM");
      const rawDays = Array.isArray(value.weekdays) ? value.weekdays : [];
      const weekdays = [...new Set(rawDays.map(Number))]
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        .sort((a, b) => a - b);
      if (weekdays.length === 0) throw new ScheduleValidationError("Pick at least one weekday");
      return { type: "weekly", weekdays, time: formatTimeOfDay(minutes) };
    }
    case "cron": {
      const expression = typeof value.expression === "string" ? value.expression.trim() : "";
      if (!parseCronExpression(expression)) {
        throw new ScheduleValidationError("Cron expression must have 5 valid fields: minute hour day month weekday");
      }
      return { type: "cron", expression };
    }
    default:
      throw new ScheduleValidationError(`Unknown schedule type: ${String(type)}`);
  }
}

// ---------------------------------------------------------------------------
// Next run computation
// ---------------------------------------------------------------------------

/**
 * Compute the next time a schedule fires at or after `from`.
 * Schedules use the server's local time. `interval` counts from `from`.
 */
export function computeNextRun(schedule: JobSchedule, from: Date = new Date()): Date | null {
  switch (schedule.type) {
    case "interval":
      return new Date(from.getTime() + schedule.everyMinutes * 60_000);
    case "hourly": {
      const candidate = startOfMinute(from);
      candidate.setMinutes(schedule.minute, 0, 0);
      if (candidate.getTime() <= from.getTime()) candidate.setHours(candidate.getHours() + 1);
      return candidate;
    }
    case "daily": {
      const minutes = parseTimeOfDay(schedule.time);
      if (minutes === null) return null;
      let candidate = atTimeOfDay(from, minutes, 0);
      if (candidate.getTime() <= from.getTime()) candidate = atTimeOfDay(from, minutes, 1);
      return candidate;
    }
    case "weekly": {
      const minutes = parseTimeOfDay(schedule.time);
      if (minutes === null) return null;
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = atTimeOfDay(from, minutes, offset);
        if (!schedule.weekdays.includes(candidate.getDay())) continue;
        if (candidate.getTime() > from.getTime()) return candidate;
      }
      return null;
    }
    case "cron": {
      const parsed = parseCronExpression(schedule.expression);
      if (!parsed) return null;
      const candidate = startOfMinute(from);
      candidate.setMinutes(candidate.getMinutes() + 1);
      const limit = 366 * 24 * 60;
      for (let i = 0; i < limit; i += 1) {
        if (
          parsed.months.has(candidate.getMonth() + 1)
          && parsed.daysOfMonth.has(candidate.getDate())
          && parsed.daysOfWeek.has(candidate.getDay())
          && parsed.hours.has(candidate.getHours())
          && parsed.minutes.has(candidate.getMinutes())
        ) {
          return new Date(candidate);
        }
        candidate.setMinutes(candidate.getMinutes() + 1);
      }
      return null;
    }
    default:
      return null;
  }
}

export function describeSchedule(schedule: JobSchedule): string {
  switch (schedule.type) {
    case "interval":
      return schedule.everyMinutes % 60 === 0
        ? `Every ${schedule.everyMinutes / 60} hour${schedule.everyMinutes === 60 ? "" : "s"}`
        : `Every ${schedule.everyMinutes} minutes`;
    case "hourly":
      return `Every hour at :${String(schedule.minute).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${schedule.time}`;
    case "weekly": {
      const days = schedule.weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
      return `Every ${days} at ${schedule.time}`;
    }
    case "cron":
      return `Cron: ${schedule.expression}`;
    default:
      return "Unknown schedule";
  }
}

// ---------------------------------------------------------------------------
// Input normalization and run history helpers
// ---------------------------------------------------------------------------

export interface JobInput {
  name: string;
  prompt: string;
  schedule: JobSchedule;
  enabled: boolean;
  cwd: string | null;
  model: { provider: string; modelId: string } | null;
}

export function normalizeJobInput(value: unknown): JobInput {
  if (!isRecord(value)) throw new ScheduleValidationError("Invalid job payload");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw new ScheduleValidationError("Name is required");
  if (name.length > MAX_NAME_CHARS) throw new ScheduleValidationError(`Name must be at most ${MAX_NAME_CHARS} characters`);
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) throw new ScheduleValidationError("Prompt is required");
  if (prompt.length > MAX_PROMPT_CHARS) throw new ScheduleValidationError(`Prompt must be at most ${MAX_PROMPT_CHARS} characters`);
  const schedule = validateSchedule(value.schedule);
  const cwd = typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : null;
  const model = isRecord(value.model)
    && typeof value.model.provider === "string"
    && typeof value.model.modelId === "string"
    && value.model.provider.trim()
    && value.model.modelId.trim()
    ? { provider: value.model.provider.trim(), modelId: value.model.modelId.trim() }
    : null;
  return { name, prompt, schedule, enabled: value.enabled !== false, cwd, model };
}

export function refreshNextRun(job: ScheduledJob, now: Date = new Date()): void {
  job.updatedAt = now.toISOString();
  job.nextRunAt = job.enabled ? computeNextRun(job.schedule, now)?.toISOString() ?? null : null;
}

export function pushJobRun(job: ScheduledJobWithRuns, run: JobRun): void {
  job.runs = [run, ...job.runs].slice(0, MAX_RUN_HISTORY);
  job.lastRunAt = run.startedAt;
  job.lastStatus = run.status;
}

export function completeJobRun(
  job: ScheduledJobWithRuns,
  runId: string,
  patch: Partial<Pick<JobRun, "status" | "summary" | "error" | "sessionId" | "model" | "finishedAt">>,
): JobRun | null {
  const run = job.runs.find((entry) => entry.id === runId);
  if (!run) return null;
  Object.assign(run, patch);
  if (run.status === "success") job.consecutiveFailures = 0;
  else if (run.status === "error") job.consecutiveFailures += 1;
  job.lastStatus = run.status;
  return run;
}
