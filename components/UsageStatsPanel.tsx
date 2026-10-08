"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { Locale } from "@/lib/i18n/types";
import type { UsageGranularity, UsageStatsResult, UsageTotals } from "@/lib/usage-types";
import { ConfigButton, ConfigPanelShell, ConfigSectionTitle } from "./SettingsUi";

interface Props {
  onClose: () => void;
}

type RangePreset = "24h" | "7d" | "30d" | "12w" | "12m" | "all";

const PRESETS: Array<{ id: RangePreset; key: string; defaultGranularity: UsageGranularity }> = [
  { id: "24h", key: "usage.last24h", defaultGranularity: "hour" },
  { id: "7d", key: "usage.last7d", defaultGranularity: "day" },
  { id: "30d", key: "usage.last30d", defaultGranularity: "day" },
  { id: "12w", key: "usage.last12w", defaultGranularity: "week" },
  { id: "12m", key: "usage.last12m", defaultGranularity: "month" },
  { id: "all", key: "usage.all", defaultGranularity: "month" },
];

const GRANULARITIES: Array<{ id: UsageGranularity; key: string }> = [
  { id: "hour", key: "usage.hour" },
  { id: "day", key: "usage.day" },
  { id: "week", key: "usage.week" },
  { id: "month", key: "usage.month" },
];

function startOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfLocalWeek(date: Date): Date {
  const next = startOfLocalDay(date);
  next.setDate(next.getDate() - ((next.getDay() + 6) % 7));
  return next;
}

function startOfLocalMonth(date: Date): Date {
  const next = startOfLocalDay(date);
  next.setDate(1);
  return next;
}

/** Window for a preset in local time; `all` leaves the lower bound open. */
function presetWindow(preset: RangePreset, now: Date): { from?: number; to: number } {
  const to = now.getTime();
  switch (preset) {
    case "24h": {
      const from = new Date(now);
      from.setMinutes(0, 0, 0);
      from.setHours(from.getHours() - 23);
      return { from: from.getTime(), to };
    }
    case "7d": {
      const start = startOfLocalDay(now);
      start.setDate(start.getDate() - 6);
      return { from: start.getTime(), to };
    }
    case "30d": {
      const start = startOfLocalDay(now);
      start.setDate(start.getDate() - 29);
      return { from: start.getTime(), to };
    }
    case "12w": {
      const start = startOfLocalWeek(now);
      start.setDate(start.getDate() - 7 * 11);
      return { from: start.getTime(), to };
    }
    case "12m": {
      const start = startOfLocalMonth(now);
      start.setMonth(start.getMonth() - 11);
      return { from: start.getTime(), to };
    }
    case "all":
      return { to };
  }
}

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

function formatBucketLabel(start: number, granularity: UsageGranularity, locale: Locale): string {
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return "";
  if (granularity === "hour") {
    return date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  if (granularity === "month") {
    return date.toLocaleDateString(locale, { year: "numeric", month: "short" });
  }
  return date.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" });
}

interface LegendSegment {
  key: keyof Pick<UsageTotals, "input" | "output" | "cacheRead" | "cacheWrite">;
  className: string;
  labelKey: string;
}

const SEGMENTS: LegendSegment[] = [
  { key: "input", className: "usage-seg-input", labelKey: "usage.input" },
  { key: "output", className: "usage-seg-output", labelKey: "usage.output" },
  { key: "cacheRead", className: "usage-seg-cache-read", labelKey: "usage.cacheRead" },
  { key: "cacheWrite", className: "usage-seg-cache-write", labelKey: "usage.cacheWrite" },
];

export function UsageStatsPanel({ onClose }: Props) {
  const { t, locale } = useI18n();
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
  const [data, setData] = useState<UsageStatsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [breakdownMode, setBreakdownMode] = useState<"model" | "provider">("model");
  const [hovered, setHovered] = useState<number | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const window = presetWindow(preset, new Date());
      const params = new URLSearchParams({ granularity });
      if (window.from !== undefined) params.set("from", String(window.from));
      params.set("to", String(window.to));
      const response = await fetch(`/api/usage?${params.toString()}`, { cache: "no-store" });
      const result = await response.json() as UsageStatsResult & { error?: string };
      if (requestId !== requestRef.current) return;
      if (!response.ok) {
        setError(result.error === "Requested range is too large for this granularity" ? t("usage.rangeTooLarge") : (result.error ?? `HTTP ${response.status}`));
        setData(null);
      } else {
        setData(result);
        setHovered(null);
      }
    } catch (cause) {
      if (requestId !== requestRef.current) return;
      setError(String(cause));
      setData(null);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [granularity, preset, t]);

  useEffect(() => { void load(); }, [load]);

  const selectPreset = (next: RangePreset) => {
    setPreset(next);
    const definition = PRESETS.find((item) => item.id === next);
    if (definition) setGranularity(definition.defaultGranularity);
  };

  const maxBucket = useMemo(
    () => data ? Math.max(1, ...data.buckets.map((bucket) => bucket.total)) : 1,
    [data],
  );

  const activeBucket = data && hovered !== null ? data.buckets[hovered] ?? null : null;
  const readout = activeBucket ?? data?.buckets.at(-1) ?? null;

  // Keep x-axis labels sparse: at most six evenly spaced buckets.
  const labelStep = data ? Math.max(1, Math.ceil(data.buckets.length / 6)) : 1;

  const breakdown = breakdownMode === "model" ? data?.models ?? [] : data?.providers ?? [];

  return (
    <ConfigPanelShell
      embedded={false}
      title={t("usage.title")}
      subtitle={t("usage.subtitle")}
      onClose={onClose}
      width={980}
      height="84vh"
    >
      <div className="usage-panel-body">
        <div className="usage-toolbar">
          <div className="usage-control-group" role="group" aria-label={t("usage.range")}>
            {PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`usage-chip${preset === item.id ? " is-active" : ""}`}
                aria-pressed={preset === item.id}
                onClick={() => selectPreset(item.id)}
              >
                {t(item.key)}
              </button>
            ))}
          </div>
          <div className="usage-control-group" role="group" aria-label={t("usage.granularity")}>
            {GRANULARITIES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`usage-chip${granularity === item.id ? " is-active" : ""}`}
                aria-pressed={granularity === item.id}
                onClick={() => setGranularity(item.id)}
              >
                {t(item.key)}
              </button>
            ))}
          </div>
          <ConfigButton variant="ghost" size="small" onClick={() => void load()} disabled={loading}>
            {t("usage.refresh")}
          </ConfigButton>
        </div>

        {error && <div className="usage-error" role="alert">{error}</div>}
        {!data && loading && <div className="usage-loading">{t("usage.loading")}</div>}
        {!data && !loading && !error && <div className="usage-loading">{t("usage.empty")}</div>}

        {data && (
          <>
            <div className="usage-summary">
              <SummaryCard
                label={t("usage.totalTokens")}
                value={compactTokens(data.totals.total)}
                exact={data.totals.total.toLocaleString(locale)}
                accent
              >
                <div className="usage-summary-breakdown">
                  {SEGMENTS.map((segment) => (
                    <span key={segment.key} className="usage-summary-item">
                      <i className={`usage-dot ${segment.className}`} aria-hidden="true" />
                      {t(segment.labelKey)} {compactTokens(data.totals[segment.key])}
                    </span>
                  ))}
                </div>
              </SummaryCard>
              <SummaryCard label={t("usage.cost")} value={formatCost(data.totals.cost)} />
              <SummaryCard label={t("usage.sessions")} value={data.sessionCount.toLocaleString(locale)} />
              <SummaryCard label={t("usage.requests")} value={data.totals.requests.toLocaleString(locale)} />
            </div>

            <section className="usage-chart-section" aria-label={t("usage.chart")}>
              <div className="usage-chart-header">
                <ConfigSectionTitle>{t("usage.chart")}</ConfigSectionTitle>
                {readout && (
                  <div className="usage-readout">
                    <span className="usage-readout-label">{formatBucketLabel(readout.start, granularity, locale)}</span>
                    <span className="usage-readout-total">{readout.total.toLocaleString(locale)} tokens</span>
                    <span className="usage-readout-cost">{formatCost(readout.cost)}</span>
                    <span className="usage-readout-sessions">
                      {readout.sessions} {t("usage.sessions").toLowerCase()}
                    </span>
                  </div>
                )}
              </div>
              <div className="usage-chart" onMouseLeave={() => setHovered(null)}>
                {data.buckets.map((bucket, index) => {
                  const heightPercent = (bucket.total / maxBucket) * 100;
                  const isHovered = hovered === index;
                  return (
                    <div
                      key={bucket.start}
                      className={`usage-bar-slot${isHovered ? " is-hovered" : ""}`}
                      onMouseEnter={() => setHovered(index)}
                    >
                      <div
                        className="usage-bar"
                        style={{ height: bucket.total > 0 ? `max(2px, ${heightPercent}%)` : "0px" }}
                      >
                        {SEGMENTS.map((segment) => {
                          const amount = bucket[segment.key];
                          if (amount <= 0) return null;
                          return (
                            <span
                              key={segment.key}
                              className={`usage-bar-seg ${segment.className}`}
                              style={{ height: `${(amount / bucket.total) * 100}%` }}
                            />
                          );
                        })}
                      </div>
                      {index % labelStep === 0 && (
                        <span className="usage-bar-label">{formatBucketLabel(bucket.start, granularity, locale)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="usage-legend">
                {SEGMENTS.map((segment) => (
                  <span key={segment.key} className="usage-legend-item">
                    <i className={`usage-dot ${segment.className}`} aria-hidden="true" />
                    {t(segment.labelKey)}
                  </span>
                ))}
              </div>
            </section>

            <section className="usage-breakdown-section">
              <div className="usage-breakdown-header">
                <ConfigSectionTitle>{t("usage.breakdown")}</ConfigSectionTitle>
                <div className="usage-control-group" role="group">
                  <button
                    type="button"
                    className={`usage-chip${breakdownMode === "model" ? " is-active" : ""}`}
                    aria-pressed={breakdownMode === "model"}
                    onClick={() => setBreakdownMode("model")}
                  >
                    {t("usage.byModel")}
                  </button>
                  <button
                    type="button"
                    className={`usage-chip${breakdownMode === "provider" ? " is-active" : ""}`}
                    aria-pressed={breakdownMode === "provider"}
                    onClick={() => setBreakdownMode("provider")}
                  >
                    {t("usage.byProvider")}
                  </button>
                </div>
              </div>
              {breakdown.length === 0 ? (
                <div className="usage-loading">{t("usage.empty")}</div>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th scope="col">{t(breakdownMode === "model" ? "usage.model" : "usage.provider")}</th>
                      <th scope="col" className="is-numeric">{t("usage.input")}</th>
                      <th scope="col" className="is-numeric">{t("usage.output")}</th>
                      <th scope="col" className="is-numeric">{t("usage.cacheRead")}</th>
                      <th scope="col" className="is-numeric">{t("usage.totalTokens")}</th>
                      <th scope="col" className="is-numeric">{t("usage.cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.map((entry) => {
                      // The bar is relative to the largest total in this table.
                      const width = breakdown[0]?.total > 0 ? `${(entry.total / breakdown[0].total) * 100}%` : "0%";
                      return (
                        <tr key={`${entry.provider}\u0000${entry.model}`}>
                          <td>
                            <div className="usage-table-name">
                              {breakdownMode === "model" && entry.provider !== "unknown" && (
                                <span className="usage-table-provider">{entry.provider}</span>
                              )}
                              <span className="usage-table-model">{breakdownMode === "model" ? entry.model : entry.provider}</span>
                            </div>
                            <div className="usage-table-track" aria-hidden="true">
                              <span className="usage-table-fill" style={{ width }} />
                            </div>
                          </td>
                          <td className="is-numeric">{compactTokens(entry.input)}</td>
                          <td className="is-numeric">{compactTokens(entry.output)}</td>
                          <td className="is-numeric">{compactTokens(entry.cacheRead + entry.cacheWrite)}</td>
                          <td className="is-numeric">{compactTokens(entry.total)}</td>
                          <td className="is-numeric">{formatCost(entry.cost)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </ConfigPanelShell>
  );
}

function SummaryCard({
  label,
  value,
  exact,
  accent = false,
  children,
}: {
  label: string;
  value: string;
  exact?: string;
  accent?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`usage-card${accent ? " is-accent" : ""}`}>
      <span className="usage-card-label">{label}</span>
      <span className="usage-card-value" title={exact}>{value}</span>
      {children}
    </div>
  );
}
