// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as dot_orchestrator_v2 from "@/lib/dot-orchestrator-v2";
import * as dot_state from "@/lib/dot-state";
import * as dot_dispatch_worker from "@/lib/dot-dispatch-worker";
import * as fs from "node:fs";
const DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot/tasks";
const PLANS = `${DIR}/plans.json`;
function recordV2Decision(text, source) {
  const pending = (0, dot_state["getLatestPendingPlan"])();
  if (!pending) throw new Error("当前没有待确认计划或待决策事项");
  pending.decisions = [...(pending.decisions ?? []), {
    text,
    source,
    createdAt: new Date().toISOString()
  }];
  pending.updatedAt = new Date().toISOString();
  const plans = (0, dot_state["listDotPlans"])();
  const index = plans.findIndex(plan => plan.planId === pending.planId);
  if (index >= 0) {
    plans[index] = pending;
    (0, fs["mkdirSync"])(DIR, {
      recursive: true
    });
    (0, fs["writeFileSync"])(PLANS, JSON.stringify(plans.slice(0, 100), null, 2));
  }
  (0, dot_orchestrator_v2["appendDotV2Event"])({
    source,
    type: "system",
    payload: {
      action: "decision_received",
      planId: pending.planId,
      decision: text
    }
  });
  return pending;
}
function operateV2Plan(action, source) {
  const pending = (0, dot_state["getLatestPendingPlan"])();
  const existing = pending ?? (0, dot_state["listDotPlans"])().find(plan => ["approved", "running", "blocked"].includes(plan.status));
  if (!existing) throw new Error("当前没有可操作的 Dot 计划");
  if (action === "approve") {
    const plan = pending ? (0, dot_state["transitionPlan"])(existing.planId, "approve") : existing;
    (0, dot_dispatch_worker["enqueueDotDispatch"])(plan.planId);
    (0, dot_orchestrator_v2["appendDotV2Event"])({
      source,
      type: "plan_approved",
      payload: {
        planId: plan.planId,
        goal: plan.goal
      }
    });
    return {
      plan,
      idempotent: !pending
    };
  }
  if (action === "cancel") {
    const plan = (0, dot_state["transitionPlan"])(existing.planId, "cancel");
    (0, dot_orchestrator_v2["appendDotV2Event"])({
      source,
      type: "system",
      payload: {
        action: "cancel_plan",
        planId: plan.planId,
        goal: plan.goal
      }
    });
    return {
      plan,
      idempotent: false
    };
  }
  const plan = existing;
  plan.status = "blocked";
  plan.updatedAt = new Date().toISOString();
  (0, dot_orchestrator_v2["appendDotV2Event"])({
    source,
    type: "system",
    payload: {
      action: "pause_plan",
      planId: plan.planId,
      goal: plan.goal
    }
  });
  return {
    plan,
    idempotent: false
  };
}
export { operateV2Plan, recordV2Decision };