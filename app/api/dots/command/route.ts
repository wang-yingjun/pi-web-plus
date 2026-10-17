// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as server from "next/server";
import * as fs from "node:fs";
import * as rpc_manager from "@/lib/rpc-manager";
import * as dot_events from "@/lib/dot-events";
import * as dot_routing from "@/lib/dot-routing";
import * as dot_plan from "@/lib/dot-plan";
import * as dot_state from "@/lib/dot-state";
import * as dot_dispatch_worker from "@/lib/dot-dispatch-worker";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;
const DOT_DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot";
const WECHAT_DIR = "/Users/yingjunwang/.pi/wechat";
const RESULT_FILE = `${WECHAT_DIR}/dot-last-result.json`;
const DOT_SESSION_FILE = `${WECHAT_DIR}/dot-shared-session.json`;
const DOT_SESSION_ID = "dot-shared-assistant";
function waitForDone(session, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = fn => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("实时 Dot 执行超时"))), timeoutMs);
    const unsubscribe = session.onEvent(event => {
      if (event.type === "prompt_done") finish(resolve);
      if (event.type === "prompt_error") finish(() => reject(new Error(String(event.errorMessage ?? "Dot 执行失败"))));
    });
  });
}
function stripPlanJson(text) {
  return text.replace(/<PLAN_JSON>[\s\S]*?<\/PLAN_JSON>/gi, "").replace(/```(?:json|plan-json)\s*[\s\S]*?```/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}
function conciseReply(text) {
  // Never cut content here: the model is responsible for compressing, so a reply
  // that arrives long is a prompt problem, not something a substring fixes.
  return stripPlanJson(text);
}
function extractLatestText(sessionFile) {
  try {
    const raw = (0, fs["readFileSync"])(sessionFile, "utf8").trim().split("\n").reverse();
    for (const line of raw) {
      const entry = JSON.parse(line);
      const message = entry?.message;
      if (entry?.type !== "message" || message?.role !== "assistant") continue;
      if (message?.stopReason === "error") throw new Error(message.errorMessage || "模型调用失败");
      const content = Array.isArray(message.content) ? message.content.filter(b => b?.type === "text").map(b => b.text).join("\n") : typeof message.content === "string" ? message.content : "";
      if (content.trim()) return content.trim();
    }
  } catch (error) {
    if (error instanceof Error && error.message !== "Unexpected end of JSON input") throw error;
  }
  return "未读取到 Dot 的文本结果。请查看项目进展面板。";
}
function cleanDotUserText(text) {
  return text.replace(/<PLAN_JSON>[\s\S]*?<\/PLAN_JSON>/gi, "").replace(/```(?:json|plan-json)\s*[\s\S]*?```/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}
async function runWithModel(command, model, progressOnly = false, sessionContext = "") {
  const context = progressOnly ? ["你是项目进展 Dot 的协调层，当前是只读项目进展汇总模式。", "不要创建任务计划，不要生成 PLAN_JSON，不要派发子 Agent，不要修改任何项目文件。", "这是一个只读请求：可能是进展汇总，也可能是定位/查找某个 Session、讨论或产出。只读取和回答，不要开工。", "请检查目标项目文件和已有 Pi Session 的最近进展，必要时读取相关 Session 文件；把各 Session 的进展合并去重，识别冲突、阻塞、风险和下一步建议。", "下一步建议必须由你这个协调层提出，不要把汇总任务再交给子 Agent。", "输出面向手机阅读，要求信息密度高而不是字数少：用要点式短句，删除寒暄、重复、解释性套话和装饰性 Markdown。", "压缩的是表达，不是信息：所有决策相关信息（数字、金额、日期、选项、风险、待决策项、下一步）必须全部保留，不得省略、不得用‘等’概括。", "如果内容确实过长：先把完整版写入 reports/ 或对应项目文件，再在回复里给出不超过 15 行但信息完整的要点汇总，并注明完整版路径。", "输出结构：项目总体判断、各 Session 进展、已完成产出、风险/阻塞、建议的下一步、需要用户决策的事项；不要展示内部协议或 JSON。", sessionContext, `用户请求：${command}`].join("\n\n") : ["你是项目进展 Dot 的实时协调/调度模式，不是具体任务执行 Agent。", "先理解用户意图、目标、优先级和约束；对复杂目标先匹配已有项目文件夹和相关 Pi Session，再规划、拆解任务和识别需要用户确认的事项。只有找不到合适 Session 时，才在原项目文件夹中新建 Session。project-progress-dot/tasks/ 只能保存索引映射，不是实际执行目录。", "用户说‘记住’或‘优先推进’时，应创建/更新目标和任务计划，不要直接假设任务已经完成。", "可以读取项目资料和本 Dot 工作区的 AGENTS.md、ROLE.md、config.md、memory.md、tracking.md。", "对明确的新工作目标，只能派发到与该目标的项目和主题都相关的已有 Session；不得因为 Session 位于同一个项目目录就向全部 Session 广播。无法确认相关性时设为 ask_user。", "完成后用中文汇报：你的理解、任务计划、当前状态、下一步、需要用户决策的事项。面向手机阅读，要求信息密度高：要点式短句，删除寒暄与套话，但所有决策相关信息（数字、日期、选项、风险）必须保留，不得省略。", "如果内容过长：先把完整版写入 Dot 工作区或对应项目文件，回复里给出不超过 15 行但信息完整的要点汇总，并注明完整版路径。不要复述指令、不要展示工具细节、不要生成日报（除非用户明确要求）。", "在回复末尾必须附加机器可读的任务计划，使用以下格式：\n<PLAN_JSON>\n{\"goal\":\"...\",\"summary\":\"...\",\"tasks\":[{\"title\":\"...\",\"description\":\"...\",\"projectPath\":\"...\",\"sessionId\":\"...\",\"sessionFile\":\"...\",\"action\":\"inspect|draft|implement|review|dispatch|ask_user\",\"priority\":\"high|medium|low\",\"needsUserDecision\":false,\"acceptanceCriteria\":[]}],\"needsUserDecision\":[],\"nextCheckAt\":\"...\"}\n</PLAN_JSON>\n。任务必须优先关联已有项目路径和已有 Session；只选择与本次目标和主题明确相关的 Session，不得向项目目录下全部 Session 派发；找不到明确相关 Session 时将 action 设为 ask_user，不得虚构 sessionId。", `用户实时指令：${command}`].join("\n\n");
  let sessionFile = "";
  try {
    const saved = JSON.parse((0, fs["readFileSync"])(DOT_SESSION_FILE, "utf8"));
    if (typeof saved.sessionFile === "string") sessionFile = saved.sessionFile;
  } catch {}
  const started = await (0, rpc_manager["startRpcSession"])(DOT_SESSION_ID, sessionFile, DOT_DIR, {
    suppressCompletionNotifications: true,
    ...(model ? {
      initialModel: model,
      allowInitialModelFallback: true
    } : {})
  });
  try {
    if (started.session.sessionFile) {
      (0, fs["writeFileSync"])(DOT_SESSION_FILE, JSON.stringify({
        sessionId: DOT_SESSION_ID,
        sessionFile: started.session.sessionFile,
        updatedAt: new Date().toISOString()
      }, null, 2));
    }
  } catch {}
  const done = waitForDone(started.session, 30 * 60 * 1000);
  await started.session.send({
    type: "prompt",
    message: context
  });
  await done;
  return extractLatestText(started.session.sessionFile);
}
function isRetryableModelError(error) {
  return /429|quota|rate.?limit|resource.?exhausted|503|502|500|unavailable|timeout|超时|额度|不可用/i.test(error instanceof Error ? error.message : String(error));
}
async function runWithFallback(command, progressOnly = false, sessionContext = "") {
  const candidates = [{
    label: "deepseek/deepseek-flash (DeepSeek V4.1 Flash)",
    model: {
      provider: "deepseek",
      modelId: "deepseek-flash"
    }
  }, {
    label: "ark/glm-5.3",
    model: {
      provider: "ark",
      modelId: "glm-5.3"
    }
  }, {
    label: "ark/deepseek-v4.1-flash",
    model: {
      provider: "ark",
      modelId: "deepseek-v4.1-flash"
    }
  }, {
    label: "gpt-relay/gpt-6.1-sol (GPT-6.1 Sol)",
    model: {
      provider: "gpt-relay",
      modelId: "gpt-6.1-sol"
    }
  }];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return {
        text: await runWithModel(command, candidate.model, progressOnly, sessionContext),
        model: candidate.label
      };
    } catch (error) {
      errors.push(`${candidate.label}: ${(error instanceof Error ? error.message : String(error)).slice(0, 240)}`);
      if (!isRetryableModelError(error)) throw error;
    }
  }
  throw new Error(`所有候选模型均不可用：\n${errors.join("\n")}`);
}
async function POST(req) {
  (0, dot_dispatch_worker["startDotDispatchWorker"])();
  const body = await req.json().catch(() => ({}));
  const command = typeof body?.command === "string" ? body.command.trim() : "";
  const userId = typeof body?.userId === "string" ? body.userId : "";
  if (!command) return server["NextResponse"].json({
    error: "command is empty"
  }, {
    status: 400
  });
  const isProgressQuery = /进展|进展情况|汇总|总结|现状|状态|怎么样|下一步|风险|阻塞|当前情况|做得怎么样|定位|查找|检索|在哪里|哪个\s*(session|会话)|上次讨论|之前讨论|回忆|我记得/i.test(command);
  if (isProgressQuery && !/^(状态|进展|status|任务状态)$/i.test(command)) {
    const sessions = await (0, dot_routing["listRelevantProjectSessions"])(command, "/Users/yingjunwang/本地工作/Home App");
    const sessionContext = sessions.length ? `目标项目：/Users/yingjunwang/本地工作/Home App\n与本次项目/主题相关的已有 Session（只读检查，不派发任务）：\n${sessions.slice(0, 30).map((session, index) => `${index + 1}. ${session.name} | id=${session.id} | modified=${session.modified} | reason=${session.reason} | first=${session.firstMessage.slice(0, 240)} | file=${session.path}`).join("\n")}` : "没有找到与本次项目/主题明确相关的已有 Session，请明确说明资料不足，不要读取或派发到无关 Session。";
    try {
      const result = await runWithFallback(command, true, sessionContext);
      const text = conciseReply(result.text);
      (0, dot_events["appendDotEvent"])({
        type: "dot_reply",
        source: userId ? "wechat" : "pi-web",
        text,
        model: result.model,
        userId: userId || undefined
      });
      (0, fs["writeFileSync"])(RESULT_FILE, JSON.stringify({
        pending: true,
        userId,
        text,
        at: new Date().toISOString(),
        mode: "progress-review",
        model: result.model
      }, null, 2));
      return server["NextResponse"].json({
        ok: true,
        model: result.model,
        text
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (0, fs["writeFileSync"])(RESULT_FILE, JSON.stringify({
        pending: true,
        userId,
        text: `⚠️ 进展汇总失败：${message}`,
        at: new Date().toISOString(),
        mode: "progress-review"
      }, null, 2));
      return server["NextResponse"].json({
        error: message
      }, {
        status: 500
      });
    }
  }
  if (/^(状态|进展|status|任务状态)/i.test(command)) {
    const plans = (0, dot_state["listDotPlans"])();
    const plan = plans.find(entry => ["awaiting_confirmation", "approved", "running", "blocked"].includes(entry.status));
    const lines = [];
    if (!plan) {
      lines.push("当前没有进行中的计划。");
    } else {
      lines.push(`计划：${plan.goal}`);
      lines.push(`状态：${plan.status}`);
      lines.push("任务：");
      for (const task of plan.tasks ?? []) {
        const note = task.lastProgress ? `：${String(task.lastProgress).replace(/\s+/g, " ").slice(0, 80)}` : task.error ? `：${String(task.error).slice(0, 80)}` : "";
        lines.push(`· [${task.status}] ${task.title}${note}`);
      }
    }
    const text = lines.join("\n");
    (0, fs["writeFileSync"])(RESULT_FILE, JSON.stringify({
      pending: true,
      userId,
      text,
      at: new Date().toISOString(),
      mode: "status"
    }, null, 2));
    return server["NextResponse"].json({
      ok: true,
      text
    });
  }
  if (/^(同意|批准|确认|执行计划|同意执行)/i.test(command)) {
    const pending = (0, dot_state["getLatestPendingPlan"])();
    // Idempotent: a repeated "同意执行" must not error out or double-dispatch.
    const recent = pending ?? (0, dot_state["listDotPlans"])().find(plan => ["approved", "running", "blocked"].includes(plan.status)) ?? null;
    if (!recent) return server["NextResponse"].json({
      error: "当前没有等待确认或执行中的计划"
    }, {
      status: 409
    });
    const approved = pending ? (0, dot_state["transitionPlan"])(pending.planId, "approve") : recent;
    (0, dot_dispatch_worker["enqueueDotDispatch"])(approved.planId);
    const dispatchable = (approved.tasks ?? []).filter(task => task.action === "dispatch" && task.sessionId);
    const text = pending ? `已批准计划「${approved.goal}」。\n\n共 ${dispatchable.length} 个任务将在已有项目 Session 中执行，其余任务等待你拍板。我会在后台派发，完成后通知你。` : `计划「${approved.goal}」已在执行中，我已重新加入派发队列，无需重复批准。`;
    (0, dot_events["appendDotEvent"])({
      type: "user_message",
      source: userId ? "wechat" : "pi-web",
      text: command,
      userId: userId || undefined
    });
    (0, dot_events["appendDotEvent"])({
      type: "dot_reply",
      source: userId ? "wechat" : "pi-web",
      text,
      userId: userId || undefined
    });
    (0, fs["writeFileSync"])(RESULT_FILE, JSON.stringify({
      pending: true,
      userId,
      text,
      at: new Date().toISOString(),
      mode: "plan-confirmation"
    }, null, 2));
    return server["NextResponse"].json({
      ok: true,
      text,
      status: approved.status
    });
  }
  if (/^(取消计划|暂停计划|取消|暂停)/i.test(command)) {
    const pending = (0, dot_state["getLatestPendingPlan"])();
    if (!pending) return server["NextResponse"].json({
      error: "当前没有等待确认的计划"
    }, {
      status: 409
    });
    const cancelled = (0, dot_state["transitionPlan"])(pending.planId, "cancel");
    const text = `已取消计划「${cancelled.goal}」，相关任务已标记为 cancelled。`;
    (0, fs["writeFileSync"])(RESULT_FILE, JSON.stringify({
      pending: true,
      userId,
      text,
      at: new Date().toISOString(),
      mode: "plan-confirmation"
    }, null, 2));
    return server["NextResponse"].json({
      ok: true,
      text,
      status: cancelled.status
    });
  }
  try {
    (0, fs["mkdirSync"])(WECHAT_DIR, {
      recursive: true
    });
    const matches = await (0, dot_routing["matchDotSessions"])(command, "/Users/yingjunwang/本地工作/Home App");
    const routingNote = matches.length ? `\n\n协调层已找到以下已有项目 Session 候选，请优先复用，不要在 Dot 目录新建实际任务：\n${matches.map((item, index) => `${index + 1}. ${item.name} | ${item.cwd} | ${item.id} | ${item.reason}`).join("\n")}` : "\n\n协调层暂未找到明确匹配的已有 Session。请先向用户说明并确认项目目录，不要擅自创建孤立工作区。";
    const routedCommand = `${command}${routingNote}`;
    const taskId = `task-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    (0, dot_routing["saveDotTaskIndex"])({
      taskId,
      title: command.slice(0, 120),
      projectPath: "/Users/yingjunwang/本地工作/Home App",
      matchedSessions: matches,
      status: "planning",
      source: userId ? "wechat" : "pi-web"
    });
    const result = await runWithFallback(routedCommand);
    const plan = (0, dot_plan["parsePlanJson"])(result.text);
    if (plan) {
      const persistedPlan = (0, dot_state["createDotPlan"])({
        goal: plan.goal,
        summary: plan.summary,
        tasks: plan.tasks,
        needsUserDecision: plan.needsUserDecision,
        nextCheckAt: plan.nextCheckAt,
        source: userId ? "wechat" : "pi-web"
      });
      for (const task of plan.tasks) {
        const taskId = task.taskId || `task-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
        (0, dot_routing["saveDotTaskIndex"])({
          taskId,
          planId: persistedPlan.planId,
          title: task.title,
          description: task.description,
          projectPath: task.projectPath,
          sessionId: task.sessionId,
          sessionFile: task.sessionFile,
          action: task.action,
          priority: task.priority,
          acceptanceCriteria: task.acceptanceCriteria,
          status: task.action === "ask_user" ? "waiting_for_user" : "awaiting_confirmation",
          sourceGoal: plan.goal
        });
      }
      (0, dot_events["appendDotEvent"])({
        type: "progress",
        source: userId ? "wechat" : "pi-web",
        text: `Dot 已生成结构化任务计划：${plan.tasks.length} 个任务，当前等待用户确认。\n${plan.summary}`,
        userId: userId || undefined
      });
    }
    if (!userId) (0, dot_events["appendDotEvent"])({
      type: "user_message",
      source: "pi-web",
      text: command
    });
    const userText = conciseReply(result.text);
    (0, dot_events["appendDotEvent"])({
      type: "dot_reply",
      source: userId ? "wechat" : "pi-web",
      text: userText,
      model: result.model,
      userId: userId || undefined
    });
    (0, fs["writeFileSync"])(RESULT_FILE, JSON.stringify({
      pending: true,
      userId,
      text: userText,
      at: new Date().toISOString(),
      mode: "realtime-command",
      model: result.model
    }, null, 2));
    return server["NextResponse"].json({
      ok: true,
      model: result.model,
      text: userText
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (0, fs["writeFileSync"])(RESULT_FILE, JSON.stringify({
      pending: true,
      userId,
      text: `⚠️ 实时 Dot 执行失败：${message}`,
      at: new Date().toISOString(),
      mode: "realtime-command"
    }, null, 2));
    return server["NextResponse"].json({
      error: message
    }, {
      status: 500
    });
  }
}
export { POST };