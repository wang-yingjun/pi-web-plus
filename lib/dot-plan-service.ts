// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as rpc_manager from "@/lib/rpc-manager";
import * as dot_state from "@/lib/dot-state";
import * as dot_orchestrator_v2 from "@/lib/dot-orchestrator-v2";
const DOT_DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot";
const SESSION_ID = "dot-shared-assistant";
const SESSION_FILE = "/Users/yingjunwang/.pi/wechat/dot-shared-session.json";
function readSharedFile() {
  try {
    return JSON.parse((0, fs["readFileSync"])(SESSION_FILE, "utf8")).sessionFile || "";
  } catch {
    return "";
  }
}
function parseJson(text) {
  const match = text.match(/```(?:json|plan-json)\s*([\s\S]*?)```/i) ?? text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1] ?? match[0]);
    if (!parsed || typeof parsed.goal !== "string" || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function latestText(file) {
  try {
    for (const line of (0, fs["readFileSync"])(file, "utf8").trim().split("\n").reverse()) {
      const e = JSON.parse(line);
      const m = e?.message;
      if (e?.type !== "message" || m?.role !== "assistant") continue;
      const text = Array.isArray(m.content) ? m.content.filter(b => b?.type === "text").map(b => b.text).join("\n") : String(m.content || "");
      if (text.trim()) return text.trim();
    }
  } catch {}
  return "";
}
async function createV2GoalPlan(goal, source) {
  const prompt = ["你是 Dot 协调层。用户提出了一个明确的新工作目标，请只制定计划，不要执行，不要修改项目文件。", "优先匹配目标项目和主题相关的已有 Pi Session；不能虚构 sessionId。找不到明确相关 Session 的任务必须标记 ask_user。", "只输出 JSON，不要 Markdown，不要解释：", JSON.stringify({
    goal: "...",
    summary: "...",
    projectPath: "/Users/yingjunwang/本地工作/Home App",
    tasks: [{
      title: "...",
      description: "...",
      action: "dispatch|ask_user",
      priority: "high|medium|low",
      sessionId: "",
      sessionFile: "",
      acceptanceCriteria: []
    }],
    needsUserDecision: [],
    nextCheckAt: ""
  }), `用户目标：${goal}`].join("\n\n");
  const started = await (0, rpc_manager["startRpcSession"])(SESSION_ID, readSharedFile(), undefined, {
    suppressCompletionNotifications: true
  });
  if (started.session.isRunning()) throw new Error("Dot 当前正在处理另一条消息，请稍后重试");
  await new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        unsubscribe();
        reject(new Error("计划生成超时"));
      }
    }, 15 * 60 * 1000);
    const unsubscribe = started.session.onEvent(event => {
      if (event.type === "prompt_done") {
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
      if (event.type === "prompt_error") {
        done = true;
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(String(event.errorMessage || "计划生成失败")));
      }
    });
    void started.session.send({
      type: "prompt",
      message: prompt
    }).catch(reject);
  });
  const raw = latestText(started.session.sessionFile);
  const plan = parseJson(raw);
  if (!plan) throw new Error("Dot 未返回有效结构化计划");
  const saved = (0, dot_state["createDotPlan"])({
    goal: plan.goal,
    summary: plan.summary || "",
    tasks: (plan.tasks || []).map(task => ({
      ...task,
      status: task.action === "ask_user" ? "waiting_for_user" : "awaiting_confirmation"
    })),
    needsUserDecision: Array.isArray(plan.needsUserDecision) ? plan.needsUserDecision : [],
    nextCheckAt: plan.nextCheckAt,
    source,
    planId: `v2-plan-${(0, crypto["randomUUID"])()}`
  });
  (0, dot_orchestrator_v2["appendDotV2Event"])({
    source,
    type: "plan_created",
    payload: {
      planId: saved.planId,
      goal: saved.goal,
      taskCount: saved.tasks.length
    }
  });
  return saved;
}
export { createV2GoalPlan };