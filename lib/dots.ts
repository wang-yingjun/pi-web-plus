import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { listScheduledJobs } from "./scheduled-jobs";

/** Root that holds dot workspaces. */
export function getDotsRoot(): string {
  return join(homedir(), "pi-cwd");
}

export interface DotStatus {
  /** Absolute path of the dot workspace. */
  dir: string;
  /** Directory name, used as the display id. */
  id: string;
  /** Human name parsed from config.md ("- Dot 名称：xxx"), falls back to id. */
  name: string;
  /** Target project parsed from config.md, if configured. */
  targetProject: string | null;
  /** True when target project path exists on disk. */
  targetConfigured: boolean;
  /** Unread replies waiting in inbox/reply.md (excluding the template header). */
  pendingReplies: number;
  /** Last reply timestamp seen in reply.md, if any. */
  lastReplyAt: string | null;
  /** Open decisions listed in inbox/pending.md. */
  pendingDecisions: number;
  /** Filename of the newest report in reports/. */
  latestReport: string | null;
  /** Full text of the newest report (capped). */
  latestReportText: string | null;
  /** memory.md modified time, ISO. */
  memoryUpdatedAt: string | null;
  /** Linked scheduled job, matched by cwd. */
  job: { id: string; name: string; time: string | null; enabled: boolean; lastStatus: string | null; lastRunAt: string | null } | null;
}

function parseConfig(dir: string): { name: string; targetProject: string | null } {
  try {
    const text = readFileSync(join(dir, "config.md"), "utf8");
    const nameMatch = text.match(/Dot 名称[：:]\s*(.+)/);
    const targetMatch = text.match(/目标项目路径[：:]\s*(.+)/);
    const target = targetMatch ? targetMatch[1].trim() : null;
    const configured = Boolean(target && !/请填写/.test(target) && existsSync(target));
    return {
      name: nameMatch ? nameMatch[1].trim() : basename(dir),
      targetProject: configured ? target : null,
    };
  } catch {
    return { name: basename(dir), targetProject: null };
  }
}

function countReplies(dir: string): { count: number; lastAt: string | null } {
  try {
    const text = readFileSync(join(dir, "inbox", "reply.md"), "utf8");
    const stamps = [...text.matchAll(/## 微信回复 ([^\n]+)/g)].map((m) => m[1].trim());
    return { count: stamps.length, lastAt: stamps.length ? stamps[stamps.length - 1] : null };
  } catch {
    return { count: 0, lastAt: null };
  }
}

function countDecisions(dir: string): number {
  try {
    const text = readFileSync(join(dir, "inbox", "pending.md"), "utf8");
    // Numbered decision items like "1. **xxx**" or "- xxx" after the header.
    const items = text.match(/(^|\n)\s*(\d+\.|-)\s+\S/g);
    return items ? items.length : 0;
  } catch {
    return 0;
  }
}

function latestReport(dir: string): { name: string | null; text: string | null } {
  try {
    const files = readdirSync(join(dir, "reports"))
      .filter((f) => f.endsWith(".md"))
      .sort();
    if (files.length === 0) return { name: null, text: null };
    const name = files[files.length - 1];
    const text = readFileSync(join(dir, "reports", name), "utf8");
    return { name, text: text.length > 20000 ? text.slice(0, 20000) + "\n…（已截断）" : text };
  } catch {
    return { name: null, text: null };
  }
}

/** List every dot workspace: a directory under the root holding daily-prompt.md + inbox/. */
export function listDots(): DotStatus[] {
  const root = getDotsRoot();
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const jobs = listScheduledJobs();
  const dots: DotStatus[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    if (!existsSync(join(dir, "daily-prompt.md")) || !existsSync(join(dir, "inbox"))) continue;
    const config = parseConfig(dir);
    const replies = countReplies(dir);
    let memoryUpdatedAt: string | null = null;
    try {
      memoryUpdatedAt = statSync(join(dir, "memory.md")).mtime.toISOString();
    } catch { /* no memory yet */ }
    const report = latestReport(dir);
    const job = jobs.find((j) => j.cwd === dir) ?? null;
    dots.push({
      dir,
      id: entry,
      name: config.name,
      targetProject: config.targetProject,
      targetConfigured: Boolean(config.targetProject),
      pendingReplies: replies.count,
      lastReplyAt: replies.lastAt,
      pendingDecisions: countDecisions(dir),
      latestReport: report.name,
      latestReportText: report.text,
      memoryUpdatedAt,
      job: job
        ? {
            id: job.id,
            name: job.name,
            time: job.schedule?.type === "daily" ? (job.schedule as { time?: string }).time ?? null : null,
            enabled: job.enabled,
            lastStatus: job.lastStatus ?? null,
            lastRunAt: job.lastRunAt ?? null,
          }
        : null,
    });
  }
  return dots;
}

/** Append a decision/instruction from the panel to the dot's inbox/reply.md. */
export function appendDotReply(dir: string, text: string): void {
  const inbox = join(dir, "inbox");
  mkdirSync(inbox, { recursive: true });
  appendFileSync(
    join(inbox, "reply.md"),
    `\n\n## 面板回复 ${new Date().toISOString()}\n\n${text}\n`,
    "utf8",
  );
}
