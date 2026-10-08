import { randomUUID } from "node:crypto";
import { openSessionManager, invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { startRpcSession, type AgentEvent } from "./rpc-manager";
import { notifyScheduledJob } from "./web-push";
import { defaultCwdPath } from "./default-cwd";
import { mkdirSync } from "node:fs";
import {
  completeJobRun,
  computeNextRun,
  getScheduledJob,
  getScheduledJobsPath,
  listScheduledJobs,
  mutateScheduledJobsState,
  pushJobRun,
  type JobRun,
  type ScheduledJobWithRuns,
  MAX_SUMMARY_CHARS,
} from "./scheduled-jobs";

/** How long a single scheduled run may take before we mark it failed. */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const TICK_INTERVAL_MS = 30_000;

// Jobs currently running in this process, so the scheduler does not double-fire.
const runningJobIds = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

interface PromptEvents {
  onEvent(listener: (event: AgentEvent) => void): () => void;
  sessionId: string;
  sessionFile: string;
}

/**
 * Resolve once the prompt's agent run settles. `prompt_done` is emitted after
 * the SDK prompt promise resolves, so it is the reliable "run finished" edge.
 */
function waitForPromptDone(session: PromptEvents, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Scheduled run timed out after ${Math.round(timeoutMs / 60_000)} minutes`)));
    }, timeoutMs);
    unsubscribe = session.onEvent((event) => {
      if (event.type === "prompt_done") finish(resolve);
      if (event.type === "prompt_error") {
        finish(() => reject(new Error(String(event.errorMessage ?? "Prompt failed"))));
      }
    });
  });
}

/** Pull the last assistant message's text out of the session transcript. */
export function readLatestAssistantText(sessionFile: string): string {
  return readLatestAssistantResult(sessionFile).summary;
}

interface AssistantResult {
  summary: string;
  error: string | null;
}

/**
 * Inspect the tail of a transcript for the final assistant turn. An assistant
 * message with `stopReason: "error"` means the provider request failed even
 * though the prompt promise resolved, so the caller must not report success.
 */
export function readLatestAssistantResult(sessionFile: string): AssistantResult {
  if (!sessionFile) return { summary: "", error: null };
  try {
    const manager = openSessionManager(sessionFile);
    const entries = manager.getBranch() as unknown as Array<{
      type?: string;
      message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
    }>;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      if (entry.message.stopReason === "error") {
        return { summary: "", error: entry.message.errorMessage || "The model request failed" };
      }
      const text = extractTextContent(entry.message.content);
      if (text) return { summary: text, error: null };
    }
  } catch {
    // A missing or malformed transcript just means no summary is shown.
  }
  return { summary: "", error: null };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim().slice(0, MAX_SUMMARY_CHARS);
  if (!Array.isArray(content)) return "";
  const text = content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const value = (block as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text.trim().slice(0, MAX_SUMMARY_CHARS);
}

function resolveRunCwd(job: ScheduledJobWithRuns): string {
  if (job.cwd && job.cwd.trim()) return job.cwd;
  try {
    const fallback = defaultCwdPath();
    mkdirSync(fallback, { recursive: true });
    return fallback;
  } catch {
    return process.cwd();
  }
}

export interface RunScheduledJobResult {
  run: JobRun | null;
  error?: string;
}

/**
 * Execute a job once and record the outcome in its run history.
 * `trigger` distinguishes scheduled fires from the panel's "Run now" button.
 */
export async function runScheduledJob(id: string, trigger: "schedule" | "manual"): Promise<RunScheduledJobResult> {
  if (runningJobIds.has(id)) {
    return { run: null, error: "Job is already running" };
  }
  const job = getScheduledJob(id);
  if (!job) return { run: null, error: "Job not found" };

  runningJobIds.add(id);
  const run: JobRun = {
    id: randomUUID(),
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    trigger,
    sessionId: null,
    model: null,
    summary: "",
    error: null,
  };

  await mutateScheduledJobsState((state) => {
    const target = state.jobs.find((entry) => entry.id === id);
    if (!target) return;
    pushJobRun(target, run);
  });

  /**
   * Resolve the session file of the job's most recent recorded run so recurring
   * jobs continue one shared conversation instead of spawning a new session
   * (and a new session-list entry) on every fire.
   */
  async function resolvePreviousJobSession(job: ScheduledJobWithRuns): Promise<{ sessionId: string; sessionFile: string } | null> {
    const previous = [...job.runs]
      .reverse()
      .find((entry) => typeof entry.sessionId === "string" && entry.sessionId);
    if (!previous?.sessionId) return null;
    const previousId: string = previous.sessionId;
    try {
      const sessionFile = await resolveSessionPath(previousId);
      return sessionFile ? { sessionId: previousId, sessionFile } : null;
    } catch {
      return null;
    }
  }

  let sessionId: string | null = null;
  try {
    const cwd = resolveRunCwd(job);
    let session;
    const previous = await resolvePreviousJobSession(job);
    if (previous) {
      // Continue the job's shared conversation; a dead registry entry is fine
      // because startRpcSession reopens the persisted transcript.
      const started = await startRpcSession(previous.sessionId, previous.sessionFile, undefined, {
        suppressCompletionNotifications: true,
        ...(job.model ? { initialModel: job.model } : {}),
      });
      session = started.session;
      sessionId = started.realSessionId;
    } else {
      const tempKey = `__job__${randomUUID()}`;
      const started = await startRpcSession(tempKey, "", cwd, {
        suppressCompletionNotifications: true,
        ...(job.model ? { initialModel: job.model } : {}),
      });
      session = started.session;
      sessionId = started.realSessionId;
      try {
        await session.send({ type: "set_session_name", name: job.name });
      } catch {
        // A rename failure must not abort the run itself.
      }
    }
    invalidateSessionListCache();

    const completion = waitForPromptDone(
      { onEvent: (listener) => session.onEvent(listener), sessionId: sessionId ?? "", sessionFile: session.sessionFile },
      RUN_TIMEOUT_MS,
    );
    await session.send({ type: "prompt", message: job.prompt });
    await completion;

    const { summary, error: runError } = readLatestAssistantResult(session.sessionFile);
    let model: JobRun["model"] = null;
    try {
      const state = await session.send({ type: "get_state" }) as { model?: { id: string; provider: string } };
      if (state?.model) model = { provider: state.model.provider, modelId: state.model.id };
    } catch {
      // Model metadata is best-effort.
    }

    if (runError) {
      await mutateScheduledJobsState((state) => {
        const target = state.jobs.find((entry) => entry.id === id);
        if (!target) return;
        completeJobRun(target, run.id, {
          status: "error",
          summary: "",
          error: runError,
          sessionId,
          model,
          finishedAt: nowIso(),
        });
        recomputeNext(target);
      });
      return { run: getRun(id, run.id), error: runError };
    }

    await mutateScheduledJobsState((state) => {
      const target = state.jobs.find((entry) => entry.id === id);
      if (!target) return;
      completeJobRun(target, run.id, {
        status: "success",
        summary,
        error: null,
        sessionId,
        model,
        finishedAt: nowIso(),
      });
      recomputeNext(target);
    });

    try {
      await notifyScheduledJob({
        jobId: id,
        jobName: job.name,
        sessionId,
        summary,
      });
    } catch {
      // Push failures are non-fatal.
    }
    return { run: getRun(id, run.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mutateScheduledJobsState((state) => {
      const target = state.jobs.find((entry) => entry.id === id);
      if (!target) return;
      completeJobRun(target, run.id, {
        status: "error",
        error: message,
        sessionId,
        finishedAt: nowIso(),
      });
      recomputeNext(target);
    });
    return { run: getRun(id, run.id), error: message };
  } finally {
    runningJobIds.delete(id);
  }
}

function recomputeNext(job: ScheduledJobWithRuns, from: Date = new Date()): void {
  job.nextRunAt = job.enabled ? computeNextRun(job.schedule, from)?.toISOString() ?? null : null;
}

function getRun(jobId: string, runId: string): JobRun | null {
  const job = getScheduledJob(jobId);
  return job?.runs.find((entry) => entry.id === runId) ?? null;
}

export function isScheduledJobRunning(id: string): boolean {
  return runningJobIds.has(id);
}

/**
 * Fire every enabled job whose nextRunAt has passed. Runs are serialized so a
 * burst of due jobs cannot exhaust the model provider at once.
 */
export async function runDueScheduledJobs(now: Date = new Date()): Promise<string[]> {
  const jobs = listScheduledJobs();
  const due = jobs.filter((job) => (
    job.enabled
    && !runningJobIds.has(job.id)
    && job.nextRunAt !== null
    && new Date(job.nextRunAt).getTime() <= now.getTime()
  ));
  const fired: string[] = [];
  for (const job of due) {
    fired.push(job.id);
    await runScheduledJob(job.id, "schedule");
  }
  return fired;
}

declare global {
  var __piScheduledJobsTimer: ReturnType<typeof setInterval> | undefined;
  var __piScheduledJobsTickRunning: boolean | undefined;
}

/** Start the in-process scheduler; safe to call more than once. */
export function startScheduledJobScheduler(): void {
  if (globalThis.__piScheduledJobsTimer) return;
  const tick = () => {
    // A long run can outlast the interval; never overlap ticks or the same due
    // job would be started twice.
    if (globalThis.__piScheduledJobsTickRunning) return;
    globalThis.__piScheduledJobsTickRunning = true;
    void runDueScheduledJobs()
      .catch((error) => {
        console.error("[pi-web] scheduled jobs tick failed:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        globalThis.__piScheduledJobsTickRunning = false;
      });
  };
  const timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  globalThis.__piScheduledJobsTimer = timer;
  const warmup = setTimeout(tick, 5_000);
  warmup.unref?.();
  console.log(`[pi-web] scheduled jobs scheduler started (state: ${getScheduledJobsPath()})`);
}

export function stopScheduledJobScheduler(): void {
  if (globalThis.__piScheduledJobsTimer) {
    clearInterval(globalThis.__piScheduledJobsTimer);
    globalThis.__piScheduledJobsTimer = undefined;
  }
}
