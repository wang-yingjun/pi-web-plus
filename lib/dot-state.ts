// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as fs from "node:fs";
import * as path from "node:path";
const DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot/tasks";
const PLANS = (0, path["join"])(DIR, "plans.json");
const TASK_INDEX = (0, path["join"])(DIR, "index.json");
function transitionTaskStatus(from, to) {
  const allowed = {
    planning: ["awaiting_confirmation", "cancelled"],
    awaiting_confirmation: ["queued", "cancelled"],
    queued: ["running", "cancelled", "blocked"],
    running: ["waiting_for_user", "waiting_for_review", "completed", "blocked", "cancelled"],
    waiting_for_user: ["queued", "cancelled", "blocked"],
    waiting_for_review: ["queued", "completed", "cancelled", "blocked"],
    completed: [],
    blocked: ["queued", "cancelled"],
    cancelled: []
  };
  return allowed[from]?.includes(to) ?? false;
}
function readPlans() {
  try {
    return JSON.parse((0, fs["readFileSync"])(PLANS, "utf8"));
  } catch {
    return [];
  }
}
function writePlans(plans) {
  (0, fs["mkdirSync"])(DIR, {
    recursive: true
  });
  (0, fs["writeFileSync"])(PLANS, JSON.stringify(plans.slice(0, 100), null, 2));
}
function syncTaskIndex(plan) {
  let tasks = [];
  try {
    tasks = JSON.parse((0, fs["readFileSync"])(TASK_INDEX, "utf8"));
  } catch {
    return;
  }
  const statusByTitle = new Map((plan.tasks ?? []).map(task => [task.title, task.status]));
  tasks = tasks.map(task => task.planId === plan.planId && statusByTitle.has(task.title) ? {
    ...task,
    status: statusByTitle.get(task.title),
    updatedAt: new Date().toISOString()
  } : task);
  (0, fs["writeFileSync"])(TASK_INDEX, JSON.stringify(tasks.slice(0, 100), null, 2));
}
function createDotPlan(plan) {
  const now = new Date().toISOString();
  const record = {
    ...plan,
    planId: plan.planId || `plan-${Date.now()}`,
    status: "awaiting_confirmation",
    createdAt: now,
    updatedAt: now
  };
  const plans = readPlans();
  plans.unshift(record);
  writePlans(plans);
  return record;
}
function getLatestPendingPlan() {
  return readPlans().find(plan => plan.status === "awaiting_confirmation") ?? null;
}
function transitionPlan(planId, action) {
  const plans = readPlans();
  const index = plans.findIndex(plan => plan.planId === planId);
  if (index < 0) throw new Error("计划不存在");
  const plan = plans[index];
  if (action === "approve") {
    if (plan.status !== "awaiting_confirmation") throw new Error(`计划当前状态为 ${plan.status}，不能批准`);
    plan.status = "approved";
    plan.tasks = (plan.tasks ?? []).map(task => ({
      ...task,
      status: task.action === "ask_user" ? "waiting_for_user" : "queued"
    }));
  } else {
    if (["completed", "cancelled"].includes(plan.status)) throw new Error(`计划当前状态为 ${plan.status}，不能取消`);
    plan.status = "cancelled";
    plan.tasks = (plan.tasks ?? []).map(task => ({
      ...task,
      status: "cancelled"
    }));
  }
  plan.updatedAt = new Date().toISOString();
  plans[index] = plan;
  writePlans(plans);
  syncTaskIndex(plan);
  return plan;
}
function listDotPlans() {
  return readPlans();
}
export { createDotPlan, getLatestPendingPlan, listDotPlans, transitionPlan, transitionTaskStatus };