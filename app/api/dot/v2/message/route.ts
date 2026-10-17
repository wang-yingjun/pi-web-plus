// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as server from "next/server";
import * as dot_orchestrator_v2 from "@/lib/dot-orchestrator-v2";
import * as dot_query from "@/lib/dot-query";
import * as dot_plan_service from "@/lib/dot-plan-service";
import * as dot_plan_operations from "@/lib/dot-plan-operations";
import * as dot_plan from "@/lib/dot-plan";
export const dynamic = "force-dynamic";
export const maxDuration = 900;
function compact(text) {
  return (0, dot_plan["stripPlanJson"])(text).trim();
}
async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const source = body?.source === "wechat" ? "wechat" : "pi-web";
  if (!text) return server["NextResponse"].json({
    error: "text is empty"
  }, {
    status: 400
  });
  const intent = (0, dot_orchestrator_v2["classifyDotIntent"])(text);
  (0, dot_orchestrator_v2["appendDotV2Event"])({
    source,
    type: "user_message",
    payload: {
      text,
      intent
    }
  });
  try {
    if (["progress_query", "session_lookup", "status_query"].includes(intent)) {
      const reply = await (0, dot_query["handleReadOnlyDotQuery"])(text, intent, source);
      const clean = compact(reply);
      (0, dot_orchestrator_v2["appendDotV2Event"])({
        source,
        type: "dot_reply",
        payload: {
          text: clean,
          intent,
          readOnly: true
        }
      });
      return server["NextResponse"].json({
        ok: true,
        intent,
        reply: clean,
        readOnly: true
      });
    }
    if (intent === "decision") {
      const plan = (0, dot_plan_operations["recordV2Decision"])(text, source);
      const reply = `已记录你的决策，暂不自动执行。\n\n计划：${plan.goal}\n\n如需启动计划，请明确回复“同意执行”。`;
      (0, dot_orchestrator_v2["appendDotV2Event"])({
        source,
        type: "dot_reply",
        payload: {
          text: reply,
          intent,
          decisionRecorded: true
        }
      });
      return server["NextResponse"].json({
        ok: true,
        intent,
        reply,
        plan,
        decisionRecorded: true
      });
    }
    if (intent === "approval" || intent === "pause" || intent === "cancel") {
      const action = intent === "approval" ? "approve" : intent;
      const result = (0, dot_plan_operations["operateV2Plan"])(action, source);
      const reply = action === "approve" ? result.idempotent ? `计划「${result.plan.goal}」已在执行或排队中，无需重复批准。` : `已批准计划「${result.plan.goal}」，任务进入统一派发队列。` : action === "pause" ? `已暂停计划「${result.plan.goal}」。` : `已取消计划「${result.plan.goal}」。`;
      (0, dot_orchestrator_v2["appendDotV2Event"])({
        source,
        type: action === "approve" ? "plan_approved" : "system",
        payload: {
          text: reply,
          planId: result.plan.planId,
          action
        }
      });
      return server["NextResponse"].json({
        ok: true,
        intent,
        reply,
        plan: result.plan
      });
    }
    if (intent === "new_work_goal") {
      const plan = await (0, dot_plan_service["createV2GoalPlan"])(text, source);
      const reply = [`已形成计划，等待你确认。`, `目标：${plan.goal}`, plan.summary || "已匹配相关项目和 Session。", ...(plan.tasks ?? []).slice(0, 6).map(task => `· ${task.title}（${task.action === "ask_user" ? "待你确认" : "待批准"}）`), "回复“同意执行”后才会派发；当前未执行任务。"].join("\n");
      (0, dot_orchestrator_v2["appendDotV2Event"])({
        source,
        type: "approval_required",
        payload: {
          text: reply,
          planId: plan.planId
        }
      });
      return server["NextResponse"].json({
        ok: true,
        intent,
        reply,
        plan,
        awaitingConfirmation: true
      });
    }
    // Ordinary conversation remains a conversation with the shared Dot, but it
    // cannot create a plan or dispatch work unless it is classified as a goal.
    const reply = "收到。请告诉我你希望查询什么，或明确说明要开始执行的工作目标。";
    (0, dot_orchestrator_v2["appendDotV2Event"])({
      source,
      type: "dot_reply",
      payload: {
        text: reply,
        intent
      }
    });
    return server["NextResponse"].json({
      ok: true,
      intent,
      reply
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (0, dot_orchestrator_v2["appendDotV2Event"])({
      source,
      type: "system",
      payload: {
        error: message,
        intent
      }
    });
    return server["NextResponse"].json({
      error: message,
      intent
    }, {
      status: 409
    });
  }
}
export { POST };