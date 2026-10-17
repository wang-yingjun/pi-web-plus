// @ts-nocheck
"use client";

// Recovered from Next dev build cache on 2026-10-17.

import * as React from "react";
import * as useI18n from "@/hooks/useI18n";
import * as SettingsUi from "@/components/SettingsUi";
const ERROR_KIND_KEY = {
  ok: "llmProbe.kindOk",
  auth: "llmProbe.kindAuth",
  quota: "llmProbe.kindQuota",
  network: "llmProbe.kindNetwork",
  server: "llmProbe.kindServer",
  unknown: "llmProbe.kindUnknown"
};
function kindColor(kind) {
  switch (kind) {
    case "quota":
      return "var(--warning, #d18f00)";
    case "auth":
    case "network":
    case "server":
      return "var(--danger, #d33)";
    default:
      return "var(--text-muted)";
  }
}
/** Trim provider error blobs down to something a human can scan. */
function cleanErrorText(raw) {
  if (!raw) return "";
  let text = raw.replace(/^\s*\d{3}\s*:\s*/, "");
  const message = text.match(/"message"\s*:\s*"([^"]+)"/);
  if (message) text = message[1];
  return text.replace(/\\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
}
function LlmProbePanel({
  onClose
}) {
  const {
    t
  } = (0, useI18n["useI18n"])();
  const [scope, setScope] = (0, React["useState"])("enabled");
  const [providerFilter, setProviderFilter] = (0, React["useState"])("all");
  const [phase, setPhase] = (0, React["useState"])("idle");
  const [targets, setTargets] = (0, React["useState"])([]);
  const [results, setResults] = (0, React["useState"])({});
  const [message, setMessage] = (0, React["useState"])(null);
  const sourceRef = (0, React["useRef"])(null);
  const stop = (0, React["useCallback"])(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);
  const start = (0, React["useCallback"])(nextScope => {
    stop();
    setPhase("running");
    setTargets([]);
    setResults({});
    setMessage(null);
    const params = new URLSearchParams({
      scope: nextScope
    });
    const source = new EventSource(`/api/llm-probe?${params.toString()}`);
    sourceRef.current = source;
    source.addEventListener("start", event => {
      const data = JSON.parse(event.data);
      setTargets(data.targets);
    });
    source.addEventListener("result", event => {
      const data = JSON.parse(event.data);
      setResults(prev => ({
        ...prev,
        [`${data.provider}/${data.model}`]: data
      }));
    });
    source.addEventListener("done", () => {
      setPhase("done");
      stop();
    });
    source.addEventListener("error", event => {
      // A server-sent `error` frame carries a message; a transport error does
      // not. Only the former should overwrite an in-progress run.
      const raw = event.data;
      if (raw) {
        try {
          setMessage(JSON.parse(raw).message ?? t("llmProbe.failedToRun"));
        } catch {
          setMessage(t("llmProbe.failedToRun"));
        }
      }
      setPhase(prev => prev === "done" ? prev : "error");
      stop();
    });
  }, [stop, t]);
  (0, React["useEffect"])(() => {
    start("enabled");
    return stop;
    // Run once when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const providers = (0, React["useMemo"])(() => {
    const set = new Set();
    for (const target of targets) set.add(target.provider);
    for (const result of Object.values(results)) set.add(result.provider);
    return Array.from(set).sort();
  }, [targets, results]);
  const list = (0, React["useMemo"])(() => {
    const rows = Object.values(results);
    if (providerFilter !== "all") return rows.filter(row => row.provider === providerFilter);
    return rows;
  }, [results, providerFilter]);
  const summary = (0, React["useMemo"])(() => {
    const done = Object.keys(results).length;
    const ok = Object.values(results).filter(row => row.ok).length;
    return {
      done,
      ok,
      failed: done - ok,
      total: targets.length
    };
  }, [results, targets.length]);
  const progress = summary.total > 0 ? Math.round(summary.done / summary.total * 100) : 0;
  return /*#__PURE__*/<SettingsUi.ConfigPanelShell embedded={false} title={t("llmProbe.title")} subtitle={t("llmProbe.subtitle")} onClose={onClose} width={720} height="78vh">{/*#__PURE__*/<div className="config-detail" style={{
      display: "flex",
      flexDirection: "column",
      gap: 14,
      minHeight: 0,
      flex: 1
    }}>{/*#__PURE__*/<div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap"
      }}>{/*#__PURE__*/<div style={{
          display: "flex",
          gap: 4,
          background: "var(--bg-hover)",
          borderRadius: 9,
          padding: 3
        }}>{["enabled", "all"].map(value => /*#__PURE__*/<button type="button" onClick={() => {
            setScope(value);
            start(value);
          }} style={{
            border: "none",
            borderRadius: 7,
            padding: "5px 12px",
            cursor: "pointer",
            fontSize: 12,
            background: scope === value ? "var(--bg, #fff)" : "transparent",
            color: scope === value ? "var(--text)" : "var(--text-muted)",
            boxShadow: scope === value ? "0 1px 2px rgba(0,0,0,.12)" : "none"
          }} key={value}>{t(value === "enabled" ? "llmProbe.scopeEnabled" : "llmProbe.scopeAll")}</button>)}</div>}{providers.length > 1 && /*#__PURE__*/<select value={providerFilter} onChange={event => setProviderFilter(event.target.value)} style={{
          height: 30,
          borderRadius: 8,
          border: "1px solid var(--border, #ddd)",
          background: "var(--bg, transparent)",
          color: "var(--text)",
          fontSize: 12,
          padding: "0 8px"
        }} aria-label={t("llmProbe.filterProvider")}>{/*#__PURE__*/<option value="all">{t("llmProbe.filterAll")}</option>}{providers.map(provider => /*#__PURE__*/<option value={provider} key={provider}>{provider}</option>)}</select>}{/*#__PURE__*/<SettingsUi.ConfigButton variant="primary" size="small" onClick={() => start(scope)} disabled={phase === "running"}>{phase === "running" ? t("llmProbe.running") : t("llmProbe.run")}</SettingsUi.ConfigButton>}{/*#__PURE__*/<span style={{
          marginLeft: "auto",
          fontSize: 12,
          color: "var(--text-muted)"
        }}>{t("llmProbe.summary", {
            ok: summary.ok,
            failed: summary.failed,
            total: summary.total || "?"
          })}</span>}</div>}{/*#__PURE__*/<div style={{
        height: 4,
        borderRadius: 2,
        background: "var(--bg-hover)",
        overflow: "hidden"
      }}>{/*#__PURE__*/<div style={{
          height: "100%",
          width: `${progress}%`,
          background: "var(--accent, #3b82f6)",
          transition: "width 0.2s ease"
        }} />}</div>}{message && /*#__PURE__*/<div style={{
        fontSize: 12,
        color: "var(--danger, #d33)"
      }}>{message}</div>}{/*#__PURE__*/<div style={{
        overflow: "auto",
        flex: 1,
        minHeight: 0,
        border: "1px solid var(--border, #e5e5e5)",
        borderRadius: 10
      }}>{/*#__PURE__*/<table style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12
        }}>{/*#__PURE__*/<thead>{/*#__PURE__*/<tr style={{
              color: "var(--text-muted)",
              textAlign: "left",
              position: "sticky",
              top: 0,
              background: "var(--bg, #fff)"
            }}>{/*#__PURE__*/<th style={{
                padding: "8px 10px",
                fontWeight: 500
              }}>{t("llmProbe.colStatus")}</th>}{/*#__PURE__*/<th style={{
                padding: "8px 10px",
                fontWeight: 500
              }}>{t("llmProbe.colModel")}</th>}{/*#__PURE__*/<th style={{
                padding: "8px 10px",
                fontWeight: 500,
                textAlign: "right"
              }}>{t("llmProbe.colLatency")}</th>}{/*#__PURE__*/<th style={{
                padding: "8px 10px",
                fontWeight: 500
              }}>{t("llmProbe.colDetail")}</th>}</tr>}</thead>}{/*#__PURE__*/<tbody>{list.length === 0 && /*#__PURE__*/<tr>{/*#__PURE__*/<td colSpan={4} style={{
                padding: "24px 10px",
                textAlign: "center",
                color: "var(--text-muted)"
              }}>{phase === "running" ? t("llmProbe.running") : t("llmProbe.empty")}</td>}</tr>}{list.map(row => /*#__PURE__*/<tr style={{
              borderTop: "1px solid var(--border, #f0f0f0)"
            }} key={`${row.provider}/${row.model}`}>{/*#__PURE__*/<td style={{
                padding: "8px 10px",
                whiteSpace: "nowrap"
              }}>{/*#__PURE__*/<SettingsUi.ConfigStatusDot active={row.ok} color={row.ok ? undefined : kindColor(row.errorKind)} />}{/*#__PURE__*/<span style={{
                  marginLeft: 6,
                  color: row.ok ? "var(--text)" : "var(--danger, #d33)"
                }}>{row.ok ? t("llmProbe.available") : t("llmProbe.unavailable")}</span>}</td>}{/*#__PURE__*/<td style={{
                padding: "8px 10px"
              }}>{/*#__PURE__*/<div style={{
                  color: "var(--text)"
                }}>{row.name}</div>}{/*#__PURE__*/<div style={{
                  color: "var(--text-muted)",
                  fontSize: 11
                }}>{row.provider}/{row.model}</div>}</td>}{/*#__PURE__*/<td style={{
                padding: "8px 10px",
                textAlign: "right",
                color: "var(--text-muted)",
                whiteSpace: "nowrap"
              }}>{row.latencyMs ? `${row.latencyMs}ms` : "—"}</td>}{/*#__PURE__*/<td style={{
                padding: "8px 10px",
                color: "var(--text-muted)"
              }}>{row.ok ? t("llmProbe.kindOk") : /*#__PURE__*/<span title={row.error ?? ""}>{row.status ? `HTTP ${row.status} · ` : ""}{t(ERROR_KIND_KEY[row.errorKind])}{row.attempts > 1 ? ` · ${t("llmProbe.attempts", {
                    count: row.attempts
                  })}` : ""}{cleanErrorText(row.error) ? ` · ${cleanErrorText(row.error)}` : ""}</span>}</td>}</tr>)}</tbody>}</table>}</div>}</div>}</SettingsUi.ConfigPanelShell>;
}
export { LlmProbePanel };