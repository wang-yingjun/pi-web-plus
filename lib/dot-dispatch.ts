// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as fs from "node:fs";
import * as rpc_manager from "@/lib/rpc-manager";
import * as dot_events from "@/lib/dot-events";
import * as dot_routing from "@/lib/dot-routing";
function latestAssistantText(sessionFile) {
  try {
    for (const line of (0, fs["readFileSync"])(sessionFile, "utf8").trim().split("\n").reverse()) {
      const entry = JSON.parse(line);
      const message = entry?.message;
      if (entry?.type !== "message" || message?.role !== "assistant") continue;
      if (message.stopReason === "error") throw new Error(message.errorMessage || "执行 Agent 调用失败");
      const text = Array.isArray(message.content) ? message.content.filter(block => block?.type === "text").map(block => block.text).join("\n") : typeof message.content === "string" ? message.content : "";
      if (text.trim()) return text.trim();
    }
  } catch (error) {
    if (error instanceof Error && !error.message.includes("Unexpected end")) throw error;
  }
  return "执行 Agent 已完成，但没有读取到文本结果。";
}
const WAIT_FOR_IDLE_MS = 3 * 60 * 1000;
const IDLE_POLL_MS = 5_000;
/** Wait until an existing session is idle, so a dispatch never collides with a live turn. */
async function waitForIdle(session, timeoutMs = WAIT_FOR_IDLE_MS) {
  const deadline = Date.now() + timeoutMs;
  while (session.isRunning()) {
    if (Date.now() > deadline) throw new Error("目标 Session 长时间处于运行中");
    await new Promise(resolve => setTimeout(resolve, IDLE_POLL_MS));
  }
}
async function dispatchToExistingSession(target) {
  const prompt = ["你是被项目进展 Dot 调度的执行 Agent。", `任务 ID：${target.taskId}`, "请在当前项目目录和当前 Session 上下文中执行下面的子任务。不要切换到 Dot 工作区，不要创建孤立工作区。", "完成后返回：已完成工作、证据/文件路径、未完成事项、风险和建议的下一步。", `子任务：${target.task}`].join("\n\n");
  let started = await (0, rpc_manager["startRpcSession"])(target.sessionId, target.sessionFile, undefined, {
    suppressCompletionNotifications: true
  });
  try {
    await waitForIdle(started.session);
  } catch {
    // A wrapper can be left "running" by an aborted earlier attempt. That is a
    // stale in-process state, not a live turn: recycle the runtime and reopen
    // the same transcript, which preserves the session's full history.
    try {
      await started.session.shutdown();
    } catch {}
    started = await (0, rpc_manager["startRpcSession"])(target.sessionId, target.sessionFile, undefined, {
      suppressCompletionNotifications: true
    });
    await waitForIdle(started.session, 30_000);
  }
  await new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        unsubscribe();
        reject(new Error("执行 Agent 超时"));
      }
    }, 30 * 60 * 1000);
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
        reject(new Error(String(event.errorMessage || "执行 Agent 失败")));
      }
    });
    void started.session.send({
      type: "prompt",
      message: prompt
    }).catch(error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    });
  });
  const text = latestAssistantText(started.session.sessionFile);
  (0, dot_routing["saveDotTaskIndex"])({
    taskId: target.taskId,
    title: target.task,
    projectPath: target.cwd,
    sessionId: target.sessionId,
    sessionFile: target.sessionFile,
    status: "running",
    lastProgress: text.slice(0, 2000),
    assignedAgent: `existing-session:${target.sessionId}`
  });
  (0, dot_events["appendDotEvent"])({
    type: "progress",
    source: "pi-web",
    text: `子任务 ${target.taskId} 已在已有 Session ${target.sessionId} 中执行完成一轮。\n\n${text}`
  });
  return text;
}
export { dispatchToExistingSession };