// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as server from "next/server";
import * as fs from "node:fs";
import * as dot_dispatch from "@/lib/dot-dispatch";
import * as dot_events from "@/lib/dot-events";
import * as dot_state from "@/lib/dot-state";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;
const PLANS = "/Users/yingjunwang/pi-cwd/project-progress-dot/tasks/plans.json";
function savePlans(plans) {
  (0, fs["writeFileSync"])(PLANS, JSON.stringify(plans.slice(0, 100), null, 2));
}
async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const planId = typeof body?.planId === "string" ? body.planId : "";
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const plans = (0, dot_state["listDotPlans"])();
  const index = plans.findIndex(plan => plan.planId === planId);
  if (!planId || index < 0) return server["NextResponse"].json({
    error: "计划不存在"
  }, {
    status: 404
  });
  const plan = plans[index];
  if (plan.status !== "approved" && plan.status !== "running") {
    return server["NextResponse"].json({
      error: `计划当前状态为 ${plan.status}，不能派发`
    }, {
      status: 409
    });
  }
  plan.status = "running";
  plan.updatedAt = new Date().toISOString();
  const results = [];
  for (const task of plan.tasks ?? []) {
    if (["completed", "cancelled"].includes(task.status)) continue;
    if (task.action === "ask_user" || !task.sessionId || !task.sessionFile) {
      task.status = "waiting_for_user";
      results.push({
        title: task.title,
        status: task.status
      });
      continue;
    }
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    try {
      const text = await (0, dot_dispatch["dispatchToExistingSession"])({
        taskId: task.taskId || `${plan.planId}-${task.title}`,
        sessionId: task.sessionId,
        sessionFile: task.sessionFile,
        cwd: task.projectPath,
        task: `${task.title}\n\n${task.description}\n\n验收标准：${(task.acceptanceCriteria ?? []).join("；") || "请返回证据、风险和下一步"}`,
        userId: userId || undefined
      });
      task.status = "waiting_for_review";
      task.lastProgress = text.slice(0, 3000);
      task.updatedAt = new Date().toISOString();
      results.push({
        title: task.title,
        status: task.status,
        text
      });
    } catch (error) {
      task.status = "blocked";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      results.push({
        title: task.title,
        status: task.status,
        error: task.error
      });
    }
  }
  if (plan.tasks?.every(task => ["completed", "cancelled", "waiting_for_user", "waiting_for_review", "blocked"].includes(task.status))) {
    plan.status = plan.tasks.some(task => task.status === "blocked") ? "blocked" : "running";
  }
  savePlans(plans);
  const summary = results.map(result => `${result.title} → ${result.status}`).join("\n");
  (0, dot_events["appendDotEvent"])({
    type: "progress",
    source: "pi-web",
    text: `计划 ${planId} 已派发：\n${summary}`
  });
  return server["NextResponse"].json({
    ok: true,
    plan,
    results
  });
}
export { POST };