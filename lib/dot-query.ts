// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as fs from "node:fs";
import * as dot_orchestrator_v2 from "@/lib/dot-orchestrator-v2";
import * as dot_routing from "@/lib/dot-routing";
import * as rpc_manager from "@/lib/rpc-manager";
const DOT_DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot";
const PROJECT_DIR = "/Users/yingjunwang/本地工作/Home App";
const SHARED_SESSION_ID = "dot-shared-assistant";
const SHARED_SESSION_FILE = "/Users/yingjunwang/.pi/wechat/dot-shared-session.json";
function latestText(sessionFile) {
  try {
    for (const line of (0, fs["readFileSync"])(sessionFile, "utf8").trim().split("\n").reverse()) {
      const entry = JSON.parse(line);
      const message = entry?.message;
      if (entry?.type !== "message" || message?.role !== "assistant") continue;
      if (message.stopReason === "error") throw new Error(message.errorMessage || "Dot 查询失败");
      const text = Array.isArray(message.content) ? message.content.filter(block => block?.type === "text").map(block => block.text).join("\n") : typeof message.content === "string" ? message.content : "";
      if (text.trim()) return text.trim();
    }
  } catch (error) {
    if (error instanceof Error && !error.message.includes("Unexpected end")) throw error;
  }
  return "未读取到查询结果。";
}
function sharedSessionFile() {
  try {
    const saved = JSON.parse((0, fs["readFileSync"])(SHARED_SESSION_FILE, "utf8"));
    return typeof saved.sessionFile === "string" ? saved.sessionFile : "";
  } catch {
    return "";
  }
}
async function handleReadOnlyDotQuery(text, intent, source) {
  const sessions = await (0, dot_routing["listRelevantProjectSessions"])(text, PROJECT_DIR);
  const sessionContext = sessions.length ? sessions.slice(0, 30).map((session, index) => `${index + 1}. ${session.name} | ${session.id} | 最近更新 ${session.modified} | 首条消息：${session.firstMessage.slice(0, 220)} | 文件：${session.path}`).join("\n") : "没有找到与本次项目/主题明确相关的已有 Session。";
  const prompt = ["你是 Dot 的协调层，当前执行只读查询。", `查询类型：${intent}`, "不要创建任务、不要生成计划 JSON、不要派发 Agent、不要修改任何文件。", "请根据项目资料和下面列出的相关 Session，回答用户的问题。Dot 自己负责汇总、判断冲突、识别风险并提出下一步建议。", "手机友好：先给结论，再给关键依据；保留数字、日期、选项、风险和待决策事项；不要展示内部路径、协议或工具细节。", `目标项目：${PROJECT_DIR}`, `相关 Session：\n${sessionContext}`, `用户问题：${text}`].join("\n\n");
  const started = await (0, rpc_manager["startRpcSession"])(SHARED_SESSION_ID, sharedSessionFile(), DOT_DIR, {
    suppressCompletionNotifications: true
  });
  const idleDeadline = Date.now() + 5 * 60 * 1000;
  while (started.session.isRunning()) {
    if (Date.now() > idleDeadline) throw new Error("Dot 当前正在处理另一条消息，请稍后重试");
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const done = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsubscribe();
        reject(new Error("只读查询超时"));
      }
    }, 15 * 60 * 1000);
    const unsubscribe = started.session.onEvent(event => {
      if (event.type === "prompt_done") {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
      if (event.type === "prompt_error") {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(String(event.errorMessage || "只读查询失败")));
      }
    });
  });
  await started.session.send({
    type: "prompt",
    message: prompt
  });
  await done;
  const reply = latestText(started.session.sessionFile);
  (0, dot_orchestrator_v2["appendDotV2Event"])({
    source,
    type: "dot_reply",
    payload: {
      text: reply,
      intent,
      readOnly: true
    }
  });
  return reply;
}
export { handleReadOnlyDotQuery };