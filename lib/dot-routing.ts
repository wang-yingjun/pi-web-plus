// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as fs from "node:fs";
import * as path from "node:path";
import * as session_reader from "@/lib/session-reader";
const DOT_DIR = "/Users/yingjunwang/pi-cwd/project-progress-dot";
const INDEX_FILE = (0, path["join"])(DOT_DIR, "tasks", "index.json");
const STOP_WORDS = ["请帮我", "帮我", "请", "项目", "当前", "进展", "情况", "汇总", "总结", "现状", "怎么样", "下一步", "风险", "阻塞", "建议", "一下"];
function tokens(text) {
  const normalized = STOP_WORDS.reduce((value, word) => value.replaceAll(word, " "), text.toLowerCase());
  return normalized.match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
}
async function listRelevantProjectSessions(command, targetProject) {
  const query = new Set(tokens(command));
  const sessions = await (0, session_reader["listAllSessions"])({
    allowStale: true
  });
  const candidates = sessions.filter(session => !session.transient && Boolean(session.path) && (session.cwd === targetProject || session.projectRoot === targetProject)).map(session => {
    const haystack = `${session.name ?? ""} ${session.firstMessage}`.toLowerCase();
    const hits = [...query].filter(token => haystack.includes(token));
    return {
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name ?? "未命名 Session",
      firstMessage: session.firstMessage,
      modified: session.modified,
      score: hits.length,
      reason: hits.length ? `主题匹配：${hits.join("、")}` : "项目内候选"
    };
  });
  // A project-wide request has no topic token, so all sessions are in scope;
  // a topic-specific request is restricted to sessions that actually match it.
  const relevant = query.size > 0 ? candidates.filter(session => session.score > 0) : candidates;
  return relevant.sort((a, b) => b.score - a.score || b.modified.localeCompare(a.modified));
}
async function matchDotSessions(command, targetProject) {
  const query = new Set(tokens(command));
  const sessions = await (0, session_reader["listAllSessions"])({
    allowStale: true
  });
  return sessions.filter(session => !session.transient && Boolean(session.path)).map(session => {
    const haystack = `${session.cwd} ${session.name ?? ""} ${session.firstMessage}`.toLowerCase();
    let score = 0;
    if (targetProject && (session.cwd === targetProject || session.projectRoot === targetProject)) score += 100;
    for (const token of query) if (haystack.includes(token)) score += 5;
    if (session.cwd.includes("Home App")) score += 20;
    const reason = score >= 100 ? "目标项目目录匹配" : score > 20 ? "项目/会话内容匹配" : "候选历史会话";
    return {
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name ?? "未命名 Session",
      firstMessage: session.firstMessage,
      modified: session.modified,
      score,
      reason
    };
  }).filter(session => session.score > 0).sort((a, b) => b.score - a.score || b.modified.localeCompare(a.modified)).slice(0, 8);
}
function saveDotTaskIndex(entry) {
  (0, fs["mkdirSync"])((0, path["join"])(DOT_DIR, "tasks"), {
    recursive: true
  });
  let items = [];
  try {
    items = JSON.parse((0, fs["readFileSync"])(INDEX_FILE, "utf8"));
  } catch {}
  const index = items.findIndex(item => item.taskId === entry.taskId);
  if (index >= 0) items[index] = {
    ...items[index],
    ...entry,
    updatedAt: new Date().toISOString()
  };else items.unshift({
    ...entry,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  (0, fs["writeFileSync"])(INDEX_FILE, JSON.stringify(items.slice(0, 100), null, 2));
}
export { listRelevantProjectSessions, matchDotSessions, saveDotTaskIndex };