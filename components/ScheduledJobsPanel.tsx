"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type {
  JobRun,
  JobSchedule,
  ScheduledJobWithRuns,
} from "@/lib/scheduled-jobs-shared";
import { describeSchedule, WEEKDAY_LABELS } from "@/lib/scheduled-jobs-shared";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

interface Props {
  /** Current project directory, used as the default working directory. */
  cwd: string | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

type ScheduleType = JobSchedule["type"];

interface Draft {
  id: string | null;
  name: string;
  prompt: string;
  enabled: boolean;
  cwd: string;
  modelKey: string;
  scheduleType: ScheduleType;
  intervalEvery: string;
  hourlyMinute: string;
  time: string;
  weekdays: number[];
  cron: string;
}

interface ModelOption {
  provider: string;
  id: string;
  name: string;
}

function modelKeyOf(model: { provider: string; modelId: string } | null): string {
  return model ? `${model.provider}\u0000${model.modelId}` : "";
}

function modelFromKey(key: string): { provider: string; modelId: string } | null {
  if (!key) return null;
  const [provider, modelId] = key.split("\u0000");
  return provider && modelId ? { provider, modelId } : null;
}

const inputStyle: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const SCHEDULE_TYPES: ScheduleType[] = ["interval", "hourly", "daily", "weekly", "cron"];

function emptyDraft(cwd: string | null): Draft {
  return {
    id: null,
    name: "",
    prompt: "",
    enabled: true,
    cwd: cwd ?? "",
    modelKey: "",
    scheduleType: "daily",
    intervalEvery: "60",
    hourlyMinute: "0",
    time: "08:00",
    weekdays: [1, 2, 3, 4, 5],
    cron: "0 8 * * *",
  };
}

function draftForJob(job: ScheduledJobWithRuns): Draft {
  const base = emptyDraft(job.cwd);
  const schedule = job.schedule;
  return {
    ...base,
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    enabled: job.enabled,
    cwd: job.cwd ?? "",
    modelKey: modelKeyOf(job.model),
    scheduleType: schedule.type,
    intervalEvery: schedule.type === "interval" ? String(schedule.everyMinutes) : base.intervalEvery,
    hourlyMinute: schedule.type === "hourly" ? String(schedule.minute) : base.hourlyMinute,
    time: schedule.type === "daily" || schedule.type === "weekly" ? schedule.time : base.time,
    weekdays: schedule.type === "weekly" ? schedule.weekdays : base.weekdays,
    cron: schedule.type === "cron" ? schedule.expression : base.cron,
  };
}

function draftToSchedule(draft: Draft): JobSchedule {
  switch (draft.scheduleType) {
    case "interval":
      return { type: "interval", everyMinutes: Number(draft.intervalEvery) };
    case "hourly":
      return { type: "hourly", minute: Number(draft.hourlyMinute) };
    case "daily":
      return { type: "daily", time: draft.time };
    case "weekly":
      return { type: "weekly", weekdays: draft.weekdays, time: draft.time };
    case "cron":
    default:
      return { type: "cron", expression: draft.cron };
  }
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatFullDateTime(iso: string | null, locale: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function ScheduledJobsPanel({ cwd, onClose, onOpenSession }: Props) {
  const { t, locale } = useI18n();
  const [jobs, setJobs] = useState<ScheduledJobWithRuns[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const response = await fetch("/api/scheduled-jobs", { cache: "no-store" });
      const body = await response.json() as { jobs?: ScheduledJobWithRuns[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const nextJobs = body.jobs ?? [];
      setJobs(nextJobs);
      setError(null);
      // Keep the open editor in sync only when the user has nothing selected
      // yet (e.g. after the first load) — never clobber an in-progress edit.
      if (selectedIdRef.current && !draft) {
        const match = nextJobs.find((job) => job.id === selectedIdRef.current);
        if (match) setDraft(draftForJob(match));
      }
    } catch (loadError) {
      if (!options.silent) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [draft]);

  // Load once, then poll so next-run and run status stay current while open.
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => void load({ silent: true }), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  // Model list powers the per-job override; unavailable when the catalogue fails.
  useEffect(() => {
    const url = cwd ? `/api/models?cwd=${encodeURIComponent(cwd)}` : "/api/models";
    void fetch(url, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { modelList?: ModelOption[] } | null) => {
        if (Array.isArray(data?.modelList)) setModels(data.modelList);
      })
      .catch(() => {});
  }, [cwd]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId],
  );

  const selectJob = (job: ScheduledJobWithRuns) => {
    setSelectedId(job.id);
    setDraft(draftForJob(job));
    setError(null);
    setNotice(null);
    setExpandedRunId(job.runs[0]?.id ?? null);
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft(emptyDraft(cwd));
    setError(null);
    setNotice(null);
  };

  const runningJob = selectedJob?.lastStatus === "running";

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        name: draft.name,
        prompt: draft.prompt,
        schedule: draftToSchedule(draft),
        enabled: draft.enabled,
        cwd: draft.cwd.trim() ? draft.cwd.trim() : null,
        model: modelFromKey(draft.modelKey),
      };
      const response = await fetch(
        draft.id ? `/api/scheduled-jobs/${draft.id}` : "/api/scheduled-jobs",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await response.json() as { job?: ScheduledJobWithRuns; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? `HTTP ${response.status}`);
      const saved = body.job;
      setJobs((current) => {
        const index = current.findIndex((job) => job.id === saved.id);
        if (index === -1) return [...current, saved];
        const next = [...current];
        next[index] = saved;
        return next;
      });
      setSelectedId(saved.id);
      selectedIdRef.current = saved.id;
      setDraft(draftForJob(saved));
      setNotice(t("jobs.saved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    if (!window.confirm(t("jobs.deleteConfirm"))) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/scheduled-jobs/${draft.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setJobs((current) => current.filter((job) => job.id !== draft.id));
      setSelectedId(null);
      selectedIdRef.current = null;
      setDraft(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!draft?.id) return;
    setError(null);
    try {
      const response = await fetch(`/api/scheduled-jobs/${draft.id}/run`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setNotice(t("jobs.runStarted"));
      window.setTimeout(() => void load({ silent: true }), 800);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    }
  };

  const toggleWeekday = (day: number) => {
    setDraft((current) => {
      if (!current) return current;
      const weekdays = current.weekdays.includes(day)
        ? current.weekdays.filter((value) => value !== day)
        : [...current.weekdays, day].sort((a, b) => a - b);
      return { ...current, weekdays };
    });
  };

  const statusLabel = (status: JobRun["status"] | null): string => {
    if (status === "success") return t("jobs.status.success");
    if (status === "error") return t("jobs.status.error");
    if (status === "running") return t("jobs.status.running");
    return t("jobs.never");
  };

  const statusColor = (job: ScheduledJobWithRuns): string | undefined => {
    if (!job.enabled) return "var(--text-dim)";
    if (job.lastStatus === "error") return "#ef4444";
    if (job.lastStatus === "success") return "#22c55e";
    if (job.lastStatus === "running") return "var(--accent)";
    return undefined;
  };

  return (
    <ConfigPanelShell
      embedded={false}
      title={t("jobs.title")}
      subtitle={`${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`}
      closeLabel={t("i18n.close")}
      onClose={onClose}
      width={1080}
      height="82vh"
    >
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading && jobs.length === 0 ? (
              <div className="config-sidebar-message">{t("i18n.loading")}</div>
            ) : jobs.length === 0 ? (
              <div className="config-sidebar-message is-empty">{t("jobs.empty")}</div>
            ) : (
              jobs.map((job) => (
                <ConfigSidebarItem
                  key={job.id}
                  active={selectedId === job.id}
                  title={`${job.name} · ${describeSchedule(job.schedule)}`}
                  onClick={() => selectJob(job)}
                >
                  <ConfigStatusDot active={job.enabled} color={statusColor(job)} />
                  <ConfigSidebarText className={`is-grow${job.enabled ? "" : " is-muted"}`}>
                    {job.name}
                  </ConfigSidebarText>
                  {job.lastStatus === "running" && <span className="scheduled-jobs-spinner" aria-hidden="true" />}
                </ConfigSidebarItem>
              ))
            )}
          </ConfigSidebarList>
          <ConfigListAction active={draft !== null && !draft.id} onClick={startNew}>
            {t("jobs.new")}
          </ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          {!draft ? (
            <ConfigEmptyState>{t("jobs.selectHint")}</ConfigEmptyState>
          ) : (
            <ConfigDetailStack>
              <ConfigDetailHeader>
                <ConfigDetailHeaderInfo>
                  <ConfigDetailTitle>{draft.id ? draft.name || t("jobs.title") : t("jobs.new")}</ConfigDetailTitle>
                </ConfigDetailHeaderInfo>
                <ConfigDetailActions>
                  {draft.id && (
                    <ConfigButton
                      variant="secondary"
                      onClick={() => void runNow()}
                      disabled={runningJob}
                    >
                      {runningJob ? t("jobs.running") : t("jobs.runNow")}
                    </ConfigButton>
                  )}
                  {draft.id && (
                    <ConfigButton variant="danger" onClick={() => void remove()} disabled={saving}>
                      {t("jobs.delete")}
                    </ConfigButton>
                  )}
                </ConfigDetailActions>
              </ConfigDetailHeader>

              <ConfigField label={t("jobs.name")}>
                <input
                  style={inputStyle}
                  value={draft.name}
                  placeholder={t("jobs.namePlaceholder")}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </ConfigField>

              <ConfigField label={t("jobs.prompt")}>
                <textarea
                  style={{ ...inputStyle, minHeight: 150, resize: "vertical", lineHeight: 1.5 }}
                  value={draft.prompt}
                  placeholder={t("jobs.promptPlaceholder")}
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                />
              </ConfigField>

              <ConfigSectionTitle>{t("jobs.schedule")}</ConfigSectionTitle>

              <ConfigField label={t("jobs.frequency")}>
                <select
                  style={inputStyle}
                  value={draft.scheduleType}
                  onChange={(event) => setDraft({ ...draft, scheduleType: event.target.value as ScheduleType })}
                >
                  {SCHEDULE_TYPES.map((type) => (
                    <option key={type} value={type}>{t(`jobs.freq.${type}`)}</option>
                  ))}
                </select>
              </ConfigField>

              {draft.scheduleType === "interval" && (
                <ConfigField label={t("jobs.everyMinutes")}>
                  <input
                    type="number"
                    min={5}
                    style={inputStyle}
                    value={draft.intervalEvery}
                    onChange={(event) => setDraft({ ...draft, intervalEvery: event.target.value })}
                  />
                </ConfigField>
              )}

              {draft.scheduleType === "hourly" && (
                <ConfigField label={t("jobs.minute")}>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    style={inputStyle}
                    value={draft.hourlyMinute}
                    onChange={(event) => setDraft({ ...draft, hourlyMinute: event.target.value })}
                  />
                </ConfigField>
              )}

              {(draft.scheduleType === "daily" || draft.scheduleType === "weekly") && (
                <ConfigField label={t("jobs.time")}>
                  <input
                    type="time"
                    style={{ ...inputStyle, maxWidth: 160 }}
                    value={draft.time}
                    onChange={(event) => setDraft({ ...draft, time: event.target.value })}
                  />
                </ConfigField>
              )}

              {draft.scheduleType === "weekly" && (
                <ConfigField label={t("jobs.weekdays")}>
                  <div className="scheduled-jobs-weekdays">
                    {WEEKDAY_LABELS.map((label, day) => (
                      <button
                        key={label}
                        type="button"
                        className="scheduled-jobs-weekday"
                        aria-pressed={draft.weekdays.includes(day)}
                        onClick={() => toggleWeekday(day)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </ConfigField>
              )}

              {draft.scheduleType === "cron" && (
                <ConfigField label={t("jobs.cronExpression")}>
                  <input
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                    value={draft.cron}
                    placeholder="0 8 * * *"
                    onChange={(event) => setDraft({ ...draft, cron: event.target.value })}
                  />
                  <span className="scheduled-jobs-hint">{t("jobs.cronHint")}</span>
                </ConfigField>
              )}

              <div className="scheduled-jobs-summary-line">
                {draft.id && selectedJob ? (
                  <>
                    <span>{describeSchedule(selectedJob.schedule)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {selectedJob.enabled && selectedJob.nextRunAt
                        ? `${t("jobs.nextRun")}: ${formatDateTime(selectedJob.nextRunAt, locale)}`
                        : t("jobs.notScheduled")}
                    </span>
                  </>
                ) : (
                  <span>{t("jobs.previewHint")}</span>
                )}
              </div>

              <ConfigField label={t("jobs.workingDirectory")}>
                <input
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  value={draft.cwd}
                  placeholder={cwd ?? ""}
                  onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
                />
                <span className="scheduled-jobs-hint">{t("jobs.workingDirectoryHint")}</span>
              </ConfigField>

              <ConfigField label={t("jobs.model")}>
                <select
                  style={inputStyle}
                  value={draft.modelKey}
                  onChange={(event) => setDraft({ ...draft, modelKey: event.target.value })}
                >
                  <option value="">{t("jobs.modelDefault")}</option>
                  {models.map((model) => (
                    <option key={`${model.provider}\u0000${model.id}`} value={`${model.provider}\u0000${model.id}`}>
                      {model.name || model.id} · {model.provider}
                    </option>
                  ))}
                </select>
              </ConfigField>

              <div className="scheduled-jobs-enabled-row">
                <span>{t("jobs.enabled")}</span>
                <ConfigSwitch
                  checked={draft.enabled}
                  label={t("jobs.enabled")}
                  onChange={(enabled) => setDraft({ ...draft, enabled })}
                />
              </div>

              {draft.id && selectedJob && (
                <>
                  <ConfigSectionTitle>{t("jobs.history")}</ConfigSectionTitle>
                  {selectedJob.runs.length === 0 ? (
                    <div className="scheduled-jobs-hint">{t("jobs.noRuns")}</div>
                  ) : (
                    <div className="scheduled-jobs-runs">
                      {selectedJob.runs.map((run) => {
                        const expanded = expandedRunId === run.id;
                        return (
                          <div key={run.id} className={`scheduled-jobs-run is-${run.status}`}>
                            <button
                              type="button"
                              className="scheduled-jobs-run-head"
                              onClick={() => setExpandedRunId(expanded ? null : run.id)}
                            >
                              <span className={`scheduled-jobs-run-dot is-${run.status}`} aria-hidden="true" />
                              <span className="scheduled-jobs-run-status">{statusLabel(run.status)}</span>
                              <span className="scheduled-jobs-run-time">
                                {formatFullDateTime(run.startedAt, locale)}
                              </span>
                              <span className="scheduled-jobs-run-trigger">
                                {run.trigger === "manual" ? t("jobs.trigger.manual") : t("jobs.trigger.schedule")}
                              </span>
                            </button>
                            {expanded && (
                              <div className="scheduled-jobs-run-body">
                                {run.error && <p className="scheduled-jobs-run-error">{run.error}</p>}
                                {run.summary && <pre className="scheduled-jobs-run-summary">{run.summary}</pre>}
                                {run.sessionId && (
                                  <ConfigButton
                                    size="small"
                                    variant="ghost"
                                    onClick={() => onOpenSession(run.sessionId as string)}
                                  >
                                    {t("jobs.openSession")}
                                  </ConfigButton>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              <ConfigFooter
                status={
                  error
                    ? <span role="alert" style={{ color: "#ef4444" }}>{error}</span>
                    : notice
                      ? <span role="status" style={{ color: "var(--accent)" }}>{notice}</span>
                      : null
                }
              >
                <ConfigButton variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
                  {t("jobs.cancel")}
                </ConfigButton>
                <ConfigButton variant="primary" onClick={() => void save()} disabled={saving}>
                  {saving ? t("jobs.saving") : draft.id ? t("jobs.save") : t("jobs.create")}
                </ConfigButton>
              </ConfigFooter>
            </ConfigDetailStack>
          )}
        </ConfigDetail>
      </ConfigSplitView>
    </ConfigPanelShell>
  );
}
