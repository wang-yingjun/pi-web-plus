// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as fs from "node:fs";
import * as path from "node:path";
import * as dot_dispatch from "@/lib/dot-dispatch";
import * as dot_orchestrator_v2 from "@/lib/dot-orchestrator-v2";
import * as dot_events from "@/lib/dot-events";
import * as dot_state from "@/lib/dot-state";
const DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot/tasks";
const PLANS = (0, path["join"])(DIR, "plans.json");
const QUEUE = (0, path["join"])(DIR, "dispatch-queue.json");
const WORKER_TICK_MS = 15_000;
const STALE_RUNNING_MS = 20 * 60 * 1000;
const MAX_TASK_WAIT_MS = 40 * 60 * 1000;
let workerRunning = false;
const inFlightPlans = new Set();
function readQueue() {
  try {
    return JSON.parse((0, fs["readFileSync"])(QUEUE, "utf8"));
  } catch {
    return [];
  }
}
function writeQueue(ids) {
  (0, fs["mkdirSync"])(DIR, {
    recursive: true
  });
  (0, fs["writeFileSync"])(QUEUE, JSON.stringify([...new Set(ids)].slice(0, 50), null, 2));
}
function savePlans(plans) {
  (0, fs["writeFileSync"])(PLANS, JSON.stringify(plans.slice(0, 100), null, 2));
}
function enqueueDotDispatch(planId) {
  writeQueue([...readQueue(), planId]);
}
function getDotDispatchQueue() {
  return readQueue();
}
async function processPlan(planId) {
  const plans = (0, dot_state["listDotPlans"])();
  const index = plans.findIndex(plan => plan.planId === planId);
  if (index < 0) return;
  const plan = plans[index];
  if (!["approved", "running", "blocked"].includes(plan.status)) return;
  const runnable = (plan.tasks ?? []).filter(task => task.action === "dispatch" && task.sessionId && task.sessionFile && ["queued", "blocked"].includes(task.status));
  if (runnable.length === 0) {
    // Nothing left to execute; settle the plan on its real blocking reason.
    const tasks = plan.tasks ?? [];
    const hasBlocked = tasks.some(task => task.status === "blocked");
    const hasWaiting = tasks.some(task => task.status === "waiting_for_user");
    const hasReview = tasks.some(task => task.status === "waiting_for_review");
    const allDone = tasks.every(task => ["completed", "cancelled"].includes(task.status));
    plan.status = allDone ? "completed" : hasBlocked ? "blocked" : hasWaiting || hasReview ? "running" : "completed";
    plan.updatedAt = new Date().toISOString();
    savePlans(plans);
    return;
  }
  plan.status = "running";
  plan.updatedAt = new Date().toISOString();
  savePlans(plans);
  for (const task of runnable) {
    const current = (0, dot_state["listDotPlans"])().find(entry => entry.planId === planId);
    const liveTask = current?.tasks?.find(entry => entry.title === task.title);
    if (!liveTask) continue;
    liveTask.status = "running";
    liveTask.updatedAt = new Date().toISOString();
    savePlans((0, dot_state["listDotPlans"])().map(entry => entry.planId === planId ? current : entry));
    (0, dot_orchestrator_v2["appendDotV2Event"])({
      source: "system",
      type: "task_started",
      payload: {
        planId,
        taskId: `${planId}-${task.title}`,
        title: task.title
      }
    });
    try {
      const text = await (0, dot_dispatch["dispatchToExistingSession"])({
        taskId: `${planId}-${task.title}`,
        sessionId: task.sessionId,
        sessionFile: task.sessionFile,
        cwd: task.projectPath,
        task: `${task.title}\n\n${task.description ?? ""}\n\n验收标准：${(task.acceptanceCriteria ?? []).join("；") || "请返回证据、风险和下一步"}`
      });
      const after = (0, dot_state["listDotPlans"])();
      const target = after.find(entry => entry.planId === planId);
      const done = target?.tasks?.find(entry => entry.title === task.title);
      if (done) {
        done.status = "waiting_for_review";
        done.lastProgress = text.slice(0, 4000);
        done.updatedAt = new Date().toISOString();
        savePlans(after);
      }
      (0, dot_orchestrator_v2["appendDotV2Event"])({
        source: "system",
        type: "task_progress",
        payload: {
          planId,
          taskId: `${planId}-${task.title}`,
          title: task.title,
          text: text.slice(0, 4000),
          status: "waiting_for_review"
        }
      });
      (0, dot_events["appendDotEvent"])({
        type: "progress",
        source: "pi-web",
        text: `子任务「${task.title}」已在已有 Session 执行完成，等待你复核。\n\n${text.slice(0, 1200)}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const after = (0, dot_state["listDotPlans"])();
      const target = after.find(entry => entry.planId === planId);
      const failed = target?.tasks?.find(entry => entry.title === task.title);
      if (failed) {
        failed.status = "blocked";
        failed.error = message;
        failed.updatedAt = new Date().toISOString();
        savePlans(after);
      }
      (0, dot_orchestrator_v2["appendDotV2Event"])({
        source: "system",
        type: "task_blocked",
        payload: {
          planId,
          taskId: `${planId}-${task.title}`,
          title: task.title,
          error: message
        }
      });
      (0, dot_events["appendDotEvent"])({
        type: "progress",
        source: "pi-web",
        text: `子任务「${task.title}」派发受阻：${message}`
      });
    }
  }
}
/** Recover tasks left in `running` by a crashed or abandoned worker. */
function resetStaleRunningTasks() {
  const plans = (0, dot_state["listDotPlans"])();
  let changed = false;
  for (const plan of plans) {
    for (const task of plan.tasks ?? []) {
      if (task.status !== "running") continue;
      const since = Date.parse(task.updatedAt ?? "");
      if (!Number.isFinite(since) || Date.now() - since < STALE_RUNNING_MS) continue;
      task.status = "blocked";
      task.error = "派发长时间无响应，已标记为 blocked，可重试";
      task.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) savePlans(plans);
}
/** Process the queue once. Returns true when a dispatch ran. */
async function drainQueueOnce() {
  resetStaleRunningTasks();
  const queue = readQueue();
  if (queue.length === 0) return false;
  const [planId, ...rest] = queue;
  writeQueue(rest);
  if (inFlightPlans.has(planId)) return false;
  inFlightPlans.add(planId);
  try {
    await processPlan(planId);
  } finally {
    inFlightPlans.delete(planId);
  }
  return true;
}
function startDotDispatchWorker() {
  if (workerRunning) return;
  workerRunning = true;
  setInterval(() => {
    void drainQueueOnce().catch(error => {
      (0, dot_events["appendDotEvent"])({
        type: "system",
        source: "pi-web",
        text: `Dot 派发工作器出错：${error instanceof Error ? error.message : String(error)}`
      });
    });
  }, WORKER_TICK_MS);
}
export { MAX_TASK_WAIT_MS, enqueueDotDispatch, getDotDispatchQueue, startDotDispatchWorker };