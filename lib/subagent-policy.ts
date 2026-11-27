import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSubagentSettingsPath } from "./subagent-settings";

export type SubagentMode = "single" | "approval" | "auto";
declare global {
  var __piTaskSubagentModes: Map<string, SubagentMode> | undefined;
}
function taskModes() {
  return globalThis.__piTaskSubagentModes ??= new Map();
}
export function parseSubagentMode(value: unknown): SubagentMode {
  if (value === undefined || value === "single") return "single";
  if (value === "approval" || value === "auto") return value;
  throw new Error("Invalid subagent execution mode");
}
export function getTaskSubagentMode(sessionId: string): SubagentMode {
  return taskModes().get(sessionId) ?? "single";
}
export function setTaskSubagentMode(sessionId: string, mode: SubagentMode) {
  if (mode === "single") taskModes().delete(sessionId);
  else taskModes().set(sessionId, mode);
}
export const MAX_DISPATCHES = 4;
export const MAX_CONCURRENT = 2;
export const MAX_TURNS = 12;
const ALLOWED_MODELS = new Set(["ark/deepseek-v4.1-flash", "ark/glm-5.3"]);

export function policyPath() {
  return join(dirname(getSubagentSettingsPath()), "policy.json");
}

export function assertAuthorizedSession(sessionId: string, path = policyPath()): void {
  let policy: unknown;
  try { policy = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("Subagent policy: no readable authorization; disabled for this session");
  }
  const ids = (policy as { authorizedSessions?: unknown } | null)?.authorizedSessions;
  if (!Array.isArray(ids) || !ids.includes(sessionId) || !sessionId.trim())
    throw new Error("Subagent policy: session not explicitly authorized");
}

export function approvedSubagentModel(profileModel?: string, override?: string): string {
  const model = profileModel?.trim();
  if (!model || !ALLOWED_MODELS.has(model))
    throw new Error("Subagent policy: explicit approved role model required; parent-model inheritance forbidden");
  if (override !== undefined && override.trim() !== model)
    throw new Error("Subagent policy: model override forbidden");
  return model;
}

/** Persistent, atomic slots: count attempts including resumes, not just simultaneous runs. */
export function reserveSubagentDispatch(sessionId: string, path = policyPath()): void {
  assertAuthorizedSession(sessionId, path);
  reserveSubagentSlot(sessionId, path);
}
export function reserveSubagentSlot(sessionId: string, path = policyPath()): void {
  const hash = createHash("sha256").update(sessionId).digest("hex");
  const dir = join(dirname(path), "dispatch-budget", hash);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 1; i <= MAX_DISPATCHES; i++) {
    try { const fd = openSync(join(dir, String(i)), "wx", 0o600); closeSync(fd); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new Error("Subagent policy: session dispatch budget exhausted (4)");
}

export function boundedSubagentTurns(request?: number): number {
  if (request === undefined || request === 0) return MAX_TURNS;
  if (!Number.isFinite(request) || request < 1) throw new Error("Invalid subagent turn limit");
  return Math.min(MAX_TURNS, Math.floor(request));
}

export function approvedSubagentThinking(profile?: string, override?: string): string {
  const value = profile ?? "low";
  if (!["off", "minimal", "low", "medium"].includes(value))
    throw new Error("Subagent policy: thinking level exceeds medium");
  if (override !== undefined && override !== value)
    throw new Error("Subagent policy: thinking override forbidden");
  return value;
}
