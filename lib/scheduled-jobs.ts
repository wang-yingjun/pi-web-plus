import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  computeNextRun,
  MAX_NAME_CHARS,
  MAX_PROMPT_CHARS,
  MAX_RUN_HISTORY,
  MAX_SUMMARY_CHARS,
  validateSchedule,
  type JobInput,
  type JobRun,
  type JobRunStatus,
  type ScheduledJob,
  type ScheduledJobsState,
  type ScheduledJobWithRuns,
} from "./scheduled-jobs-shared";

export * from "./scheduled-jobs-shared";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getScheduledJobsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "scheduled-jobs.json");
}

function emptyState(): ScheduledJobsState {
  return { version: 1, jobs: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRun(value: unknown): JobRun | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : randomUUID();
  const startedAt = typeof value.startedAt === "string" ? value.startedAt : new Date().toISOString();
  const status: JobRunStatus = value.status === "success" || value.status === "error" || value.status === "running"
    ? value.status
    : "error";
  return {
    id,
    startedAt,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : null,
    status,
    trigger: value.trigger === "manual" ? "manual" : "schedule",
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    model: isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.modelId === "string"
      ? { provider: value.model.provider, modelId: value.model.modelId }
      : null,
    summary: typeof value.summary === "string" ? value.summary.slice(0, MAX_SUMMARY_CHARS) : "",
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizeJob(value: unknown): ScheduledJobWithRuns | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.prompt !== "string") return null;
  let schedule;
  try {
    schedule = validateSchedule(value.schedule);
  } catch {
    return null;
  }
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString();
  const runs = Array.isArray(value.runs)
    ? value.runs.map(normalizeRun).filter((run): run is JobRun => run !== null).slice(0, MAX_RUN_HISTORY)
    : [];
  const lastStatus: JobRunStatus | null = value.lastStatus === "success" || value.lastStatus === "error" || value.lastStatus === "running"
    ? value.lastStatus
    : null;
  return {
    id: value.id,
    name: value.name.slice(0, MAX_NAME_CHARS),
    prompt: value.prompt.slice(0, MAX_PROMPT_CHARS),
    schedule,
    enabled: value.enabled !== false,
    cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : null,
    model: isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.modelId === "string"
      ? { provider: value.model.provider, modelId: value.model.modelId }
      : null,
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
    nextRunAt: typeof value.nextRunAt === "string" ? value.nextRunAt : null,
    lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : null,
    lastStatus,
    consecutiveFailures: Number.isInteger(value.consecutiveFailures) ? Number(value.consecutiveFailures) : 0,
    runs,
  };
}

/** Read the on-disk state, tolerating a missing or corrupt file. */
export function readScheduledJobsState(path = getScheduledJobsPath()): ScheduledJobsState {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) return emptyState();
    return {
      version: 1,
      jobs: parsed.jobs.map(normalizeJob).filter((job): job is ScheduledJobWithRuns => job !== null),
    };
  } catch {
    return emptyState();
  }
}

export function writeScheduledJobsState(state: ScheduledJobsState, path = getScheduledJobsPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

// Serialize read-modify-write cycles inside the server process.
let mutationChain: Promise<unknown> = Promise.resolve();

export function mutateScheduledJobsState<T>(
  mutator: (state: ScheduledJobsState) => T,
  path = getScheduledJobsPath(),
): Promise<T> {
  const run = mutationChain.then(() => {
    const state = readScheduledJobsState(path);
    const result = mutator(state);
    writeScheduledJobsState(state, path);
    return result;
  });
  // Keep the chain alive even when a mutation rejects.
  mutationChain = run.catch(() => undefined);
  return run;
}

export function listScheduledJobs(path = getScheduledJobsPath()): ScheduledJobWithRuns[] {
  return readScheduledJobsState(path).jobs;
}

export function getScheduledJob(id: string, path = getScheduledJobsPath()): ScheduledJobWithRuns | null {
  return readScheduledJobsState(path).jobs.find((job) => job.id === id) ?? null;
}

export function createScheduledJob(input: JobInput, now: Date = new Date()): ScheduledJobWithRuns {
  return {
    id: randomUUID(),
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled,
    cwd: input.cwd,
    model: input.model,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextRunAt: input.enabled ? computeNextRun(input.schedule, now)?.toISOString() ?? null : null,
    lastRunAt: null,
    lastStatus: null,
    consecutiveFailures: 0,
    runs: [],
  };
}

/** Exported for tests that need an empty in-memory job shape. */
export function makeScheduledJob(input: {
  id: string;
  name: string;
  prompt: string;
  schedule: ScheduledJob["schedule"];
  enabled?: boolean;
}): ScheduledJobWithRuns {
  return {
    id: input.id,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled !== false,
    cwd: null,
    model: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    consecutiveFailures: 0,
    runs: [],
  };
}
