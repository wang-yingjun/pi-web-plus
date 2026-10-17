// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as dot_orchestrator_v2 from "@/lib/dot-orchestrator-v2";
const DOT_DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot";
const EVENTS_FILE = (0, path["join"])(DOT_DIR, "events.jsonl");
function appendDotEvent(event) {
  (0, fs["mkdirSync"])(DOT_DIR, {
    recursive: true
  });
  const full = {
    id: event.id ?? (0, crypto["randomUUID"])(),
    dotId: event.dotId ?? "project-progress-dot",
    createdAt: event.createdAt ?? new Date().toISOString(),
    type: event.type,
    source: event.source,
    text: event.text,
    ...(event.userId ? {
      userId: event.userId
    } : {}),
    ...(event.model ? {
      model: event.model
    } : {})
  };
  (0, fs["appendFileSync"])(EVENTS_FILE, `${JSON.stringify(full)}\n`, "utf8");
  return full;
}
/** Strip protocol blocks and internal suffixes so old and new events compare equal. */
function normalizeForDisplay(text) {
  return text.replace(/<PLAN_JSON>[\s\S]*?<\/PLAN_JSON>/gi, "").replace(/```(?:json|plan-json)\s*[\s\S]*?```/gi, "").replace(/\n{0,2}（[^）]*(?:模型|本次为只读)[^）]*）\s*$/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function listDotEvents(after, limit = 100) {
  let lines;
  try {
    lines = (0, fs["readFileSync"])(EVENTS_FILE, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const events = [];
  for (const line of lines.slice(-Math.max(limit * 3, 300))) {
    try {
      const parsed = JSON.parse(line);
      if (after && parsed.createdAt <= after) continue;
      const event = {
        ...parsed,
        text: normalizeForDisplay(parsed.text) || parsed.text
      };
      // Two writers used to log the same reply seconds apart; collapse those so
      // the panel never shows one answer twice.
      const previous = events[events.length - 1];
      if (previous && previous.type === event.type && previous.text === event.text) {
        const gap = Math.abs(Date.parse(event.createdAt) - Date.parse(previous.createdAt));
        if (Number.isFinite(gap) && gap < 120_000) continue;
      }
      events.push(event);
    } catch {}
  }
  const legacyEvents = [];
  for (const event of (0, dot_orchestrator_v2["listDotV2Events"])(0, 300)) {
    const payload = event.payload ?? {};
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text && event.type !== "user_message") continue;
    const type = event.type === "user_message" ? "user_message" : event.type === "dot_reply" ? "dot_reply" : event.type === "system" ? "system" : "progress";
    legacyEvents.push({
      id: event.eventId,
      dotId: event.dotId,
      type,
      source: event.source === "scheduler" ? "scheduler" : event.source === "wechat" ? "wechat" : "pi-web",
      text: text || String(payload.action || event.type),
      createdAt: event.createdAt
    });
  }
  events.push(...legacyEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const deduped = [];
  for (const event of events) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.type === event.type && previous.text === event.text) {
      const gap = Math.abs(Date.parse(event.createdAt) - Date.parse(previous.createdAt));
      if (Number.isFinite(gap) && gap < 120_000) continue;
    }
    deduped.push(event);
  }
  return deduped.slice(-limit);
}
export { appendDotEvent, listDotEvents };