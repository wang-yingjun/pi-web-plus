// @ts-nocheck
"use client";

// Recovered from Next dev build cache on 2026-10-17.

import * as React from "react";
import * as useI18n from "@/hooks/useI18n";
import * as SettingsUi from "@/components/SettingsUi";
const STATUS_LABEL = {
  planning: "规划中",
  awaiting_confirmation: "待确认",
  approved: "已批准",
  queued: "排队中",
  running: "执行中",
  waiting_for_user: "待你决策",
  waiting_for_review: "待复核",
  completed: "已完成",
  blocked: "受阻",
  cancelled: "已取消"
};
const STATUS_COLOR = {
  planning: "#8a8f98",
  awaiting_confirmation: "#e0a52e",
  approved: "#3f7fbf",
  queued: "#8a8f98",
  running: "#3f7fbf",
  waiting_for_user: "#e0a52e",
  waiting_for_review: "#8a5fbf",
  completed: "#3fbf6f",
  blocked: "#e05252",
  cancelled: "#8a8f98"
};
const ACTION_LABEL = {
  inspect: "检查",
  draft: "起草",
  implement: "实现",
  review: "审查",
  dispatch: "派发",
  ask_user: "待决策"
};
const PRIORITY_LABEL = {
  high: "高",
  medium: "中",
  low: "低"
};
function formatTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}
function StatusBadge({
  status
}) {
  const key = status ?? "planning";
  const color = STATUS_COLOR[key] ?? "#8a8f98";
  return /*#__PURE__*/<span style={{
    display: "inline-block",
    padding: "1px 7px",
    borderRadius: 999,
    fontSize: 11,
    lineHeight: "17px",
    color,
    background: `${color}1a`,
    border: `1px solid ${color}44`,
    whiteSpace: "nowrap"
  }}>{STATUS_LABEL[key] ?? key}</span>;
}
function Metric({
  label,
  value,
  hint,
  tone
}) {
  return /*#__PURE__*/<div style={{
    padding: "10px 12px",
    border: "1px solid var(--border)",
    borderRadius: 10,
    background: "var(--bg-panel)",
    minWidth: 0
  }}>{/*#__PURE__*/<div style={{
      fontSize: 11,
      color: "var(--text-muted)",
      marginBottom: 4
    }}>{label}</div>}{/*#__PURE__*/<div style={{
      fontSize: 14,
      color: tone ?? "var(--text)",
      fontWeight: 600,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }} title={value}>{value}</div>}{hint ? /*#__PURE__*/<div style={{
      fontSize: 11,
      color: "var(--text-muted)",
      marginTop: 3
    }}>{hint}</div> : null}</div>;
}
function DotsPanel({
  onClose
}) {
  const {
    t: translate
  } = (0, useI18n["useI18n"])();
  const [dots, setDots] = (0, React["useState"])([]);
  const [plan, setPlan] = (0, React["useState"])(null);
  const [events, setEvents] = (0, React["useState"])([]);
  const [selected, setSelected] = (0, React["useState"])(null);
  const [tab, setTab] = (0, React["useState"])("chat");
  const [reply, setReply] = (0, React["useState"])("");
  const [busy, setBusy] = (0, React["useState"])(false);
  const [status, setStatus] = (0, React["useState"])("");
  const [error, setError] = (0, React["useState"])("");
  const chatEndRef = (0, React["useRef"])(null);
  const refresh = (0, React["useCallback"])(async () => {
    try {
      const res = await fetch("/api/dots", {
        cache: "no-store"
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDots(data.dots ?? []);
      setPlan(data.plan ?? null);
      setEvents(data.events ?? []);
      setError("");
      setSelected(prev => prev && data.dots?.some(d => d.id === prev) ? prev : data.dots?.[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  (0, React["useEffect"])(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);
  (0, React["useEffect"])(() => {
    if (tab === "chat") chatEndRef.current?.scrollIntoView({
      block: "end"
    });
  }, [events.length, tab]);
  const dot = dots.find(d => d.id === selected) ?? null;
  const tasks = plan?.tasks ?? [];
  const running = tasks.some(task => task.status === "running");
  const sendReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    setStatus("");
    const text = reply;
    setReply("");
    try {
      const res = await fetch("/api/dot/v2/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          source: "pi-web"
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus("✅ 已处理");
      await refresh();
    } catch (err) {
      setStatus(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const runNow = async () => {
    await sendReplyFor("请汇总一下当前项目进展，并建议下一步");
  };
  const sendReplyFor = async command => {
    setBusy(true);
    setStatus("");
    try {
      const res = await fetch("/api/dot/v2/message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: command,
          source: "pi-web"
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus("✅ 已处理");
      await refresh();
    } catch (err) {
      setStatus(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const tabButton = (key, label, count) => /*#__PURE__*/<button type="button" onClick={() => setTab(key)} style={{
    padding: "6px 12px",
    borderRadius: 8,
    fontSize: 12,
    cursor: "pointer",
    background: tab === key ? "var(--bg-hover)" : "transparent",
    border: `1px solid ${tab === key ? "var(--border)" : "transparent"}`,
    color: tab === key ? "var(--text)" : "var(--text-muted)"
  }} key={key}>{label}{count ? ` (${count})` : ""}</button>;
  return /*#__PURE__*/<SettingsUi.ConfigPanelShell embedded={false} title={translate("dots.title")} onClose={onClose}>{/*#__PURE__*/<SettingsUi.ConfigSplitView>{/*#__PURE__*/<div style={{
        width: 240,
        borderRight: "1px solid var(--border)",
        overflowY: "auto",
        flexShrink: 0
      }}>{dots.length === 0 ? /*#__PURE__*/<div style={{
          padding: "12px 12px",
          fontSize: 12,
          color: "var(--text-muted)"
        }}>加载中…</div> : dots.map(d => {
          const color = !d.targetConfigured ? "#e05252" : running ? "#3f7fbf" : d.pendingDecisions > 0 ? "#e0a52e" : "#3fbf6f";
          const active = d.id === selected;
          return /*#__PURE__*/<button type="button" onClick={() => {
            setSelected(d.id);
            setStatus("");
          }} style={{
            display: "flex",
            gap: 8,
            width: "100%",
            textAlign: "left",
            alignItems: "flex-start",
            padding: "10px 12px",
            background: active ? "var(--bg-hover)" : "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--text)"
          }} key={d.id}>{/*#__PURE__*/<span style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: color,
              marginTop: 5,
              flexShrink: 0
            }} />}{/*#__PURE__*/<span style={{
              minWidth: 0
            }}>{/*#__PURE__*/<div style={{
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}>{d.name}</div>}{/*#__PURE__*/<div style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginTop: 2
              }}>{d.job?.time ? `每天 ${d.job.time}` : "未配置定时"}{d.pendingDecisions > 0 ? ` · ${d.pendingDecisions} 待决策` : ""}</div>}</span>}</button>;
        })}</div>}{/*#__PURE__*/<div style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }}>{dot ? /*#__PURE__*/<>{/*#__PURE__*/<div style={{
            padding: "14px 16px 10px",
            borderBottom: "1px solid var(--border)"
          }}>{/*#__PURE__*/<div style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              justifyContent: "space-between"
            }}>{/*#__PURE__*/<div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0
              }}>{/*#__PURE__*/<span style={{
                  fontSize: 16,
                  fontWeight: 600
                }}>{dot.name}</span>}{/*#__PURE__*/<StatusBadge status={plan?.status ?? "planning"} />}{running ? /*#__PURE__*/<span style={{
                  fontSize: 11,
                  color: "#3f7fbf"
                }}>● 执行中</span> : null}</div>}{/*#__PURE__*/<div style={{
                display: "flex",
                gap: 8
              }}>{/*#__PURE__*/<button type="button" disabled={busy} onClick={() => void runNow()} style={btnStyle(busy)}>刷新进展</button>}{/*#__PURE__*/<button type="button" disabled={busy} onClick={() => void sendReplyFor("状态")} style={btnStyle(busy)}>任务状态</button>}</div>}</div>}{/*#__PURE__*/<div style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}>{dot.dir}</div>}{plan?.goal ? /*#__PURE__*/<div style={{
              fontSize: 12,
              marginTop: 8,
              color: "var(--text)"
            }}>🎯 {plan.goal}</div> : null}</div>}{/*#__PURE__*/<div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
            gap: 8,
            padding: "12px 16px"
          }}>{/*#__PURE__*/<Metric label="目标项目" value={dot.targetProject ?? "未配置"} />}{/*#__PURE__*/<Metric label="定时" value={dot.job?.time ? `每天 ${dot.job.time}` : "未配置"} />}{/*#__PURE__*/<Metric label="上次运行" value={formatTime(dot.job?.lastRunAt ?? null)} hint={dot.job?.lastStatus === "success" ? "成功" : dot.job?.lastStatus ?? undefined} />}{/*#__PURE__*/<Metric label="待决策" value={`${dot.pendingDecisions} 项`} tone={dot.pendingDecisions > 0 ? "#e0a52e" : undefined} />}{/*#__PURE__*/<Metric label="进行中任务" value={`${tasks.filter(task => task.status === "running").length} 个`} />}{/*#__PURE__*/<Metric label="未处理回复" value={`${dot.pendingReplies} 条`} tone={dot.pendingReplies > 0 ? "#3f7fbf" : undefined} />}</div>}{/*#__PURE__*/<div style={{
            display: "flex",
            gap: 6,
            padding: "0 16px 8px",
            borderBottom: "1px solid var(--border)"
          }}>{tabButton("chat", "对话", events.length)}{tabButton("tasks", "任务", tasks.length)}{tabButton("report", "日报")}</div>}{/*#__PURE__*/<div style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 16px"
          }}>{tab === "chat" ? events.length === 0 ? /*#__PURE__*/<Empty>还没有对话。在下面输入框里发第一条消息。</Empty> : events.map(event => /*#__PURE__*/<div style={{
              display: "flex",
              justifyContent: event.type === "user_message" ? "flex-end" : "flex-start",
              marginBottom: 10
            }} key={event.id}>{/*#__PURE__*/<div style={{
                maxWidth: "82%",
                padding: "8px 11px",
                borderRadius: 10,
                fontSize: 12.5,
                lineHeight: 1.65,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: event.type === "user_message" ? "var(--bg-hover)" : "var(--bg-panel)",
                border: `1px solid var(--border)`,
                borderLeft: event.type === "progress" ? "3px solid #3f7fbf" : undefined
              }}>{/*#__PURE__*/<div style={{
                  fontSize: 10.5,
                  color: "var(--text-muted)",
                  marginBottom: 4
                }}>{event.type === "user_message" ? "你" : event.type === "progress" ? "进展" : "Dot"} · {formatTime(event.createdAt)}{event.model ? ` · ${event.model}` : ""}</div>}{event.text}</div>}</div>) : tab === "tasks" ? tasks.length === 0 ? /*#__PURE__*/<Empty>当前没有任务计划。</Empty> : /*#__PURE__*/<div style={{
              display: "flex",
              flexDirection: "column",
              gap: 8
            }}>{tasks.map((task, index) => /*#__PURE__*/<div style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: "10px 12px",
                background: "var(--bg-panel)"
              }} key={`${index}-${task.title}`}>{/*#__PURE__*/<div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap"
                }}>{/*#__PURE__*/<StatusBadge status={task.status} />}{task.action ? /*#__PURE__*/<span style={{
                    fontSize: 11,
                    color: "var(--text-muted)"
                  }}>{ACTION_LABEL[task.action] ?? task.action}</span> : null}{task.priority ? /*#__PURE__*/<span style={{
                    fontSize: 11,
                    color: "var(--text-muted)"
                  }}>优先级 {PRIORITY_LABEL[task.priority] ?? task.priority}</span> : null}{/*#__PURE__*/<span style={{
                    fontSize: 13,
                    fontWeight: 600
                  }}>{task.title}</span>}</div>}{task.description ? /*#__PURE__*/<div style={{
                  fontSize: 12,
                  color: "var(--text)",
                  marginTop: 6,
                  lineHeight: 1.6
                }}>{task.description}</div> : null}{task.sessionId ? /*#__PURE__*/<div style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  marginTop: 6
                }}>Session: {task.sessionId}</div> : null}{task.error ? /*#__PURE__*/<div style={{
                  fontSize: 11.5,
                  color: "#e05252",
                  marginTop: 6
                }}>⚠️ {task.error}</div> : null}{task.lastProgress ? /*#__PURE__*/<div style={{
                  fontSize: 11.5,
                  color: "var(--text-muted)",
                  marginTop: 6,
                  whiteSpace: "pre-wrap",
                  maxHeight: 120,
                  overflow: "auto"
                }}>{task.lastProgress}</div> : null}</div>)}</div> : dot.latestReportText ? /*#__PURE__*/<pre style={preStyle}>{dot.latestReportText}</pre> : /*#__PURE__*/<Empty>暂无日报。每天 08:30 自动生成。</Empty>}{/*#__PURE__*/<div ref={chatEndRef} />}</div>}{/*#__PURE__*/<div style={{
            borderTop: "1px solid var(--border)",
            padding: "10px 16px 12px"
          }}>{/*#__PURE__*/<div style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-end"
            }}>{/*#__PURE__*/<textarea value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendReply();
              }} placeholder="给 Dot 发消息…（⌘/Ctrl+Enter 发送）" rows={2} style={{
                flex: 1,
                padding: "8px 10px",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text)",
                fontSize: 12.5,
                resize: "vertical",
                boxSizing: "border-box"
              }} />}{/*#__PURE__*/<button type="button" disabled={busy || !reply.trim()} onClick={() => void sendReply()} style={btnStyle(busy || !reply.trim())}>{busy ? "处理中…" : "发送"}</button>}</div>}{/*#__PURE__*/<div style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 6,
              minHeight: 14
            }}>{status}{error ? `⚠️ ${error}` : ""}</div>}</div>}</> : /*#__PURE__*/<div style={{
          padding: 20
        }}>{/*#__PURE__*/<Empty>{error ? `⚠️ ${error}` : "选择左侧的 Dot"}</Empty>}</div>}</div>}</SettingsUi.ConfigSplitView>}</SettingsUi.ConfigPanelShell>;
}
function btnStyle(disabled) {
  return {
    padding: "5px 12px",
    borderRadius: 8,
    fontSize: 12,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    color: disabled ? "var(--text-muted)" : "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1
  };
}
function Empty({
  children
}) {
  return /*#__PURE__*/<div style={{
    fontSize: 12.5,
    color: "var(--text-muted)",
    padding: "16px 4px"
  }}>{children}</div>;
}
const preStyle = {
  margin: 0,
  padding: 12,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.7,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word"
};
export { DotsPanel };