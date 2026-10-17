// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
const DOT_DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot";
const EVENTS = (0, path["join"])(DOT_DIR, "events-v2.jsonl");
const SEQUENCE = (0, path["join"])(DOT_DIR, "events-v2-sequence.json");
const DOT_ID = "project-progress-dot";
const CONVERSATION_ID = "dot-shared-assistant";
const QUERY_RE = /进展|汇总|总结|现状|风险|阻塞|怎么样|下一步|定位|查找|检索|在哪里|哪个\s*(session|会话)|上次讨论|之前讨论|回忆|状态/i;
const LOOKUP_RE = /定位|查找|检索|在哪里|哪个\s*(session|会话)|上次讨论|之前讨论|回忆/i;
const DECISION_RE = /(^|\n)\s*(\d+[\.、:：)]|[一二三四五六七八九十]+[、.)])|选择|选用|决定|暂不|不考虑|同意|否决/i;
const DECISION_MARKER_RE = /选择|选用|决定|暂不|不考虑|否决|^\s*\d+[\.、:：)]/im;
const APPROVAL_RE = /^(同意|批准|确认|执行计划|同意执行)/i;
const PAUSE_RE = /^(暂停|暂停计划)/i;
const CANCEL_RE = /^(取消|取消计划|停止计划)/i;
// These verbs express an actual work goal even when the sentence starts with
// "帮我" or is phrased as a question. They must not fall through to chat.
const WORK_RE = /开始|执行|推进|起草|实现|制作|整理|制定|写一份|创建|完成|调研|研究|搜索|搜集|调查|分析|梳理|评估|比较|撰写|准备|发布|验证|测试/i;
function classifyDotIntent(text) {
  const value = text.trim();
  if (APPROVAL_RE.test(value)) return "approval";
  if (DECISION_RE.test(value) && DECISION_MARKER_RE.test(value)) return "decision";
  if (PAUSE_RE.test(value)) return "pause";
  if (CANCEL_RE.test(value)) return "cancel";
  if (/^(状态|任务状态|status)$/i.test(value)) return "status_query";
  if (WORK_RE.test(value)) return "new_work_goal";
  if (QUERY_RE.test(value)) {
    return LOOKUP_RE.test(value) ? "session_lookup" : "progress_query";
  }
  return "conversation";
}
function nextSequence() {
  (0, fs["mkdirSync"])(DOT_DIR, {
    recursive: true
  });
  let current = 0;
  try {
    current = Number(JSON.parse((0, fs["readFileSync"])(SEQUENCE, "utf8")).value) || 0;
  } catch {}
  const next = current + 1;
  const temp = `${SEQUENCE}.${process.pid}.tmp`;
  (0, fs["writeFileSync"])(temp, JSON.stringify({
    value: next
  }));
  (0, fs["renameSync"])(temp, SEQUENCE);
  return next;
}
function appendDotV2Event(input) {
  (0, fs["mkdirSync"])(DOT_DIR, {
    recursive: true
  });
  const event = {
    eventId: (0, crypto["randomUUID"])(),
    sequence: nextSequence(),
    conversationId: input.conversationId ?? CONVERSATION_ID,
    dotId: DOT_ID,
    source: input.source,
    type: input.type,
    payload: input.payload,
    createdAt: new Date().toISOString()
  };
  (0, fs["appendFileSync"])(EVENTS, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}
function listDotV2Events(afterSequence = 0, limit = 100) {
  try {
    return (0, fs["readFileSync"])(EVENTS, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.sequence > afterSequence).slice(-limit);
  } catch {
    return [];
  }
}
function orchestratorSnapshot(text) {
  const intent = classifyDotIntent(text);
  return {
    intent,
    requiresConfirmation: intent === "new_work_goal",
    // V2 deliberately does not dispatch yet. Dispatch is a separate, explicit phase.
    dispatchAllowed: false
  };
}
export { appendDotV2Event, classifyDotIntent, listDotV2Events, orchestratorSnapshot };