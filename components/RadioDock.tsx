"use client";

// RadioDock — a floating, collapsible internet-radio player for pi-web.
//
// Modeled on the Hermes Desktop "Radio" plugin: pinned presets, Radio Browser
// search, play/pause, a Next that cycles stations, volume, and a live waveform.
// It lives bottom-right and collapses to a small pill.
//
// Real waveform, honestly: cross-origin streams that allow CORS are routed
// through a WebAudio AnalyserNode and drawn from samples. Streams that refuse
// CORS cannot be analysed and are played directly (a MediaElementSource would
// mute them), so they show an activity indicator — never invented levels.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type Station = {
  id: string;
  name: string;
  description?: string;
  provider: string;
  url: string;
  homepage?: string;
};

const NIGHTRIDE = "https://stream.nightride.fm/";

const PRESETS: Station[] = [
  { id: "chillsynth", name: "Chillsynth", description: "Soft focus · warm synths", provider: "Nightride FM", url: `${NIGHTRIDE}chillsynth.mp3`, homepage: "https://nightride.fm/?station=chillsynth" },
  { id: "nightride", name: "Nightride", description: "Synthwave · after hours", provider: "Nightride FM", url: `${NIGHTRIDE}nightride.mp3`, homepage: "https://nightride.fm/" },
  { id: "darksynth", name: "Darksynth", description: "Dark electronics · high energy", provider: "Nightride FM", url: `${NIGHTRIDE}darksynth.mp3`, homepage: "https://nightride.fm/?station=darksynth" },
  { id: "spacesynth", name: "Spacesynth", description: "Cosmic synths · retro futures", provider: "Nightride FM", url: `${NIGHTRIDE}spacesynth.mp3`, homepage: "https://nightride.fm/?station=spacesynth" },
  { id: "paradise-main", name: "Main Mix", description: "Eclectic · human selected", provider: "Radio Paradise", url: "https://stream.radioparadise.com/aac-128", homepage: "https://radioparadise.com/" },
  { id: "paradise-mellow", name: "Mellow Mix", description: "A gentler pace", provider: "Radio Paradise", url: "https://stream.radioparadise.com/mellow-flac", homepage: "https://radioparadise.com/" },
  { id: "eve-radio", name: "EVE Radio", description: "GamingNow · EVE community radio", provider: "GamingNow", url: "https://media01.gamingnow.net:8010/erweb.mp3", homepage: "https://gamingnow.net/eve-radio/" },
  // A few stations that Radio Browser indexes under other names, or not at all.
  { id: "cnr-1", name: "中国之声", description: "中央人民广播电台 · CNR-1", provider: "CNR", url: "https://lhttp.qtfm.cn/live/15318317/64k.mp3" },
  { id: "zj-voice", name: "浙江之声", description: "浙江广电 · FM88", provider: "浙江广电", url: "http://ali-m-l.cztv.com/channels/lantian/fm88/128k.m3u8" },
  { id: "rthk-radio2", name: "香港电台第二台", description: "RTHK Radio 2", provider: "RTHK", url: "http://stm2.rthk.hk/radio2", homepage: "https://www.rthk.hk/radio/radio2" },
  { id: "kuco-kcsc", name: "KUCO / KCSC 古典", description: "Classical · Oklahoma", provider: "KUCO", url: "https://ice8.securenetsystems.net/KCSC", homepage: "https://kuco.org/" },
  { id: "kgou", name: "KGOU", description: "NPR · Oklahoma", provider: "KGOU", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/KGOUFM_64.mp3", homepage: "https://kgou.org/" },
];

const LS = {
  collapsed: "piweb.radio.collapsed",
  station: "piweb.radio.station",
  volume: "piweb.radio.volume",
  pinned: "piweb.radio.pinned",
};

const MIRRORS = [
  "https://de2.api.radio-browser.info",
  "https://de1.api.radio-browser.info",
  "https://nl1.api.radio-browser.info",
  "https://at1.api.radio-browser.info",
  "https://fi1.api.radio-browser.info",
];

function streamUrl(value: string): string | null {
  try {
    const url = new URL(value);
    // http is allowed: pi-web is served from http://127.0.0.1, so there is no
    // mixed-content block, and many radio streams are http-only.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

function sameStation(a: Station, b: Station) {
  return a.id === b.id || a.url === b.url;
}

function dedupe(list: Station[]): Station[] {
  const seenId = new Set<string>();
  const seenUrl = new Set<string>();
  return list.filter((s) => {
    if (seenId.has(s.id) || seenUrl.has(s.url)) return false;
    seenId.add(s.id);
    seenUrl.add(s.url);
    return true;
  });
}

async function searchMirror(mirror: string, text: string, signal: AbortSignal): Promise<Station[]> {
  const params = new URLSearchParams({ name: text, limit: "60", order: "votes", reverse: "true" });
  const res = await fetch(`${mirror}/json/stations/search?${params.toString()}`, { signal, credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const out: Station[] = [];
  for (const row of rows) {
    const url = typeof row.url_resolved === "string" ? streamUrl(row.url_resolved) : null;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const id = typeof row.stationuuid === "string" ? row.stationuuid : "";
    if (!url || !name || !id) continue;
    out.push({
      id,
      name,
      url,
      provider: "Radio Browser",
      description: [typeof row.country === "string" ? row.country : "", typeof row.tags === "string" ? row.tags.split(",").slice(0, 2).join(" · ") : ""]
        .filter(Boolean)
        .join(" · ") || undefined,
      homepage: typeof row.homepage === "string" ? streamUrl(row.homepage) ?? undefined : undefined,
    });
  }
  return out;
}

async function searchStations(text: string, signal: AbortSignal): Promise<Station[]> {
  let lastError: unknown = null;
  for (const mirror of MIRRORS) {
    if (signal.aborted) break;
    try {
      const rows = await searchMirror(mirror, text, signal);
      if (rows.length > 0) return dedupe(rows);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError && signal.aborted) throw lastError;
  return [];
}

async function corsAllowed(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    await fetch(url, { mode: "cors", credentials: "omit", signal: ctrl.signal });
    clearTimeout(timer);
    ctrl.abort();
    return true;
  } catch {
    return false;
  }
}

export function RadioDock() {
  const [collapsed, setCollapsed] = useState<boolean>(() => loadStored(LS.collapsed, true));
  const [station, setStation] = useState<Station>(() => {
    const stored = loadStored<Station | null>(LS.station, null);
    return stored?.url ? stored : PRESETS[0];
  });
  const [pinned, setPinned] = useState<Station[]>(() => loadStored<Station[]>(LS.pinned, []));
  const [searchResults, setSearchResults] = useState<Station[] | null>(null);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "playing" | "paused" | "error">("idle");
  const [volume, setVolume] = useState<number>(() => {
    const v = loadStored<number>(LS.volume, 25);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 25;
  });
  const [muted, setMuted] = useState(false);

  const corsAudioRef = useRef<HTMLAudioElement | null>(null);
  const plainAudioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const graphReadyRef = useRef(false);
  const currentCorsRef = useRef(false);
  const activeRef = useRef<"cors" | "plain" | null>(null);
  const playTokenRef = useRef(0);

  useEffect(() => store(LS.collapsed, collapsed), [collapsed]);
  useEffect(() => store(LS.station, station), [station]);
  useEffect(() => store(LS.volume, volume), [volume]);
  useEffect(() => store(LS.pinned, pinned), [pinned]);

  // ── Audio elements ────────────────────────────────────────────────────
  useEffect(() => {
    const corsAudio = new Audio();
    const plainAudio = new Audio();
    for (const audio of [corsAudio, plainAudio]) {
      audio.preload = "none";
      audio.volume = volume / 100;
    }
    corsAudioRef.current = corsAudio;
    plainAudioRef.current = plainAudio;
    const onPlaying = () => setStatus("playing");
    const onWaiting = () => setStatus((s) => (s === "playing" ? "connecting" : s));
    const onPause = () => setStatus((s) => (s === "error" ? s : "paused"));
    const onError = () => setStatus("error");
    for (const audio of [corsAudio, plainAudio]) {
      audio.addEventListener("playing", onPlaying);
      audio.addEventListener("waiting", onWaiting);
      audio.addEventListener("pause", onPause);
      audio.addEventListener("error", onError);
    }
    return () => {
      for (const audio of [corsAudio, plainAudio]) {
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("waiting", onWaiting);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("error", onError);
        audio.pause();
        audio.src = "";
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const vol = muted ? 0 : volume / 100;
    if (corsAudioRef.current) corsAudioRef.current.volume = vol;
    if (plainAudioRef.current) plainAudioRef.current.volume = vol;
  }, [volume, muted]);

  /** Build the WebAudio graph once, on the CORS-capable element. */
  const ensureGraph = useCallback(() => {
    const audio = corsAudioRef.current;
    if (!audio || graphReadyRef.current) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioCtxRef.current ?? new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      graphReadyRef.current = true;
      void ctx.resume();
    } catch {
      graphReadyRef.current = false;
    }
  }, []);

  const stopAll = useCallback(() => {
    for (const audio of [corsAudioRef.current, plainAudioRef.current]) {
      if (!audio) continue;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    activeRef.current = null;
  }, []);

  const play = useCallback(
    async (next?: Station) => {
      const target = next ?? station;
      if (next) setStation(next);
      const token = ++playTokenRef.current;
      setStatus("connecting");
      setPlaying(true);

      const cors = await corsAllowed(target.url);
      if (token !== playTokenRef.current) return; // superseded by a newer click

      stopAll();
      if (cors) {
        const audio = corsAudioRef.current;
        if (!audio) return;
        currentCorsRef.current = true;
        audio.crossOrigin = "anonymous";
        audio.src = target.url;
        ensureGraph();
        activeRef.current = "cors";
        try {
          await audio.play();
        } catch {
          setStatus("error");
          setPlaying(false);
        }
      } else {
        // No CORS: play directly — routing through WebAudio would mute it.
        const audio = plainAudioRef.current;
        if (!audio) return;
        currentCorsRef.current = false;
        audio.crossOrigin = null;
        audio.src = target.url;
        activeRef.current = "plain";
        try {
          await audio.play();
        } catch {
          setStatus("error");
          setPlaying(false);
        }
      }
    },
    [station, ensureGraph, stopAll],
  );

  const pause = useCallback(() => {
    playTokenRef.current++;
    stopAll();
    setPlaying(false);
    setStatus("paused");
  }, [stopAll]);

  // ── List composition ──────────────────────────────────────────────────
  // No search: favourites first, then the curated presets. Searching: matches
  // first (the point of the search), then favourites/presets below.
  const displayStations = useMemo(() => {
    const q = search.trim();
    const base = dedupe([...pinned, ...PRESETS]);
    if (q.length < 2) return base;
    const matches = (searchResults ?? []).filter((s) => !base.some((b) => sameStation(b, s)));
    return dedupe([...matches, ...base]);
  }, [search, searchResults, pinned]);
  const matchCount = useMemo(() => {
    const q = search.trim();
    if (q.length < 2) return 0;
    return (searchResults ?? []).filter((s) => !pinned.some((p) => sameStation(p, s))).length;
  }, [search, searchResults, pinned]);
  const displayStationsRef = useRef<Station[]>(displayStations);
  useEffect(() => {
    displayStationsRef.current = displayStations;
  }, [displayStations]);

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const list = displayStationsRef.current.length ? displayStationsRef.current : PRESETS;
      const idx = list.findIndex((s) => sameStation(s, station));
      void play(list[(idx + dir + list.length) % list.length]);
    },
    [station, play],
  );

  const toggle = useCallback(() => {
    if (playing) pause();
    else void play();
  }, [playing, pause, play]);

  // ── Visualizer ────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const data = new Uint8Array(256);
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3b82f6";
      const bars = 40;
      const gap = 2;
      const bw = (w - gap * (bars - 1)) / bars;
      ctx.fillStyle = accent;

      let levels: number[] | null = null;
      if (currentCorsRef.current && analyserRef.current && status === "playing") {
        analyserRef.current.getByteFrequencyData(data);
        let peak = 0;
        levels = new Array(bars);
        for (let i = 0; i < bars; i++) {
          const v = data[Math.floor((i / bars) * data.length)] / 255;
          peak = Math.max(peak, v);
          levels[i] = v;
        }
        // All-zero while "playing" means the stream is silent or was tainted —
        // fall through to the honest activity indicator, not a fake waveform.
        if (peak === 0) levels = null;
      }

      if (levels) {
        for (let i = 0; i < bars; i++) {
          const v = levels[i];
          const bh = Math.max(1, v * h);
          ctx.globalAlpha = 0.35 + v * 0.65;
          ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
        }
      } else if (status === "connecting" || (status === "playing" && !currentCorsRef.current)) {
        // Activity indicator: a single soft sweep, clearly not audio levels.
        const t = (Date.now() % 1400) / 1400;
        ctx.globalAlpha = 0.5;
        const cw = w * 0.35;
        const x = t * (w + cw) - cw;
        const grad = ctx.createLinearGradient(x, 0, x + cw, 0);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(0.5, accent);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.fillRect(x, h - 3, cw, 3);
      } else {
        ctx.globalAlpha = 0.15;
        ctx.fillRect(0, h - 2, w, 2);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  // ── Search (debounced) ────────────────────────────────────────────────
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setSearchResults(null);
      setSearching(false);
      setSearchError(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    setSearchError(false);
    const t = setTimeout(() => {
      searchStations(q, ctrl.signal)
        .then((results) => {
          if (!ctrl.signal.aborted) setSearchResults(results);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setSearchError(true);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setSearching(false);
        });
    }, 350);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [search]);

  const isPinned = (s: Station) => pinned.some((p) => sameStation(p, s));
  const togglePin = (s: Station) =>
    setPinned((prev) => (prev.some((p) => sameStation(p, s)) ? prev.filter((p) => !sameStation(p, s)) : [s, ...prev]));

  const statusText =
    status === "playing" ? (currentCorsRef.current ? "直播中 · 实时波形" : "直播中 · 该台不支持波形分析") : status === "connecting" ? "正在连接…" : status === "error" ? "无法播放，试试其他电台" : "已暂停";

  const searchingActive = search.trim().length >= 2;

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      <style>{`
        .pi-radio-panel { pointer-events:auto; }
        .pi-radio-row:hover { background: var(--bg-hover); }
        .pi-radio-btn { transition: background 120ms ease, color 120ms ease; }
        .pi-radio-btn:hover { background: var(--bg-hover); }
        .pi-radio-scroll::-webkit-scrollbar { width: 8px; }
        .pi-radio-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
        @keyframes pi-radio-eq { from { transform: scaleY(.4);} to { transform: scaleY(1.2);} }
      `}</style>

      {!collapsed && (
        <div
          className="pi-radio-panel"
          style={{
            width: 300,
            maxWidth: "calc(100vw - 32px)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            boxShadow: "0 18px 40px -18px rgba(0,0,0,0.35)",
            overflow: "hidden",
            color: "var(--text)",
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <span style={{ fontSize: 15 }}>📻</span>
            <span style={{ fontWeight: 600, flex: 1 }}>网络电台</span>
            <button className="pi-radio-btn" onClick={() => setCollapsed(true)} title="收起" style={iconBtn}>
              ▾
            </button>
          </div>

          <div style={{ padding: "10px 12px 6px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{station.name}</span>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{station.provider}</span>
            </div>
            <div style={{ color: status === "error" ? "#e5484d" : "var(--text-dim)", fontSize: 11, marginTop: 2 }}>{statusText}</div>
          </div>

          <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: 40, color: "var(--accent)" }} />

          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px" }}>
            <button className="pi-radio-btn" onClick={() => cycle(-1)} title="上一个电台" style={iconBtn}>
              ⏮
            </button>
            <button
              className="pi-radio-btn"
              onClick={toggle}
              title={playing ? "暂停" : "播放"}
              style={{ ...iconBtn, background: playing ? "var(--bg-hover)" : "var(--accent)", color: playing ? "var(--text)" : "var(--accent-contrast)", width: 30, height: 30 }}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <button className="pi-radio-btn" onClick={() => cycle(1)} title="下一个电台" style={iconBtn}>
              ⏭
            </button>
            <button className="pi-radio-btn" onClick={() => setMuted((m) => !m)} title={muted ? "取消静音" : "静音"} style={iconBtn}>
              {muted || volume === 0 ? "🔇" : "🔊"}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              style={{ flex: 1, minWidth: 0, accentColor: "var(--accent)" }}
              title={`音量 ${volume}`}
            />
            {station.homepage && (
              <a className="pi-radio-btn" href={station.homepage} target="_blank" rel="noopener noreferrer" title="访问电台网站" style={{ ...iconBtn, textDecoration: "none", color: "var(--text-dim)" }}>
                ↗
              </a>
            )}
          </div>

          <div style={{ padding: "0 12px 8px" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索电台（如 中国之声、浙江、jazz）…"
              style={{
                width: "100%",
                boxSizing: "border-box",
                height: 30,
                padding: "0 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-subtle)",
                color: "var(--text)",
                fontSize: 12,
                outline: "none",
              }}
            />
            {searchingActive && (
              <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 4 }}>
                {searching ? "正在搜索…" : searchError ? "搜索失败（镜像不可用），下方仍可播放收藏/精选" : `匹配 ${matchCount} 个 · 未找到时可换更短的关键词`}
              </div>
            )}
          </div>

          <div className="pi-radio-scroll" style={{ maxHeight: 208, overflowY: "auto", padding: "0 6px 8px" }}>
            {displayStations.map((s, idx) => {
              const current = sameStation(s, station);
              const isMatch = searchingActive && (searchResults ?? []).some((r) => sameStation(r, s));
              const prev = idx > 0 ? displayStations[idx - 1] : null;
              const showDivider = !searchingActive && idx > 0 && pinned.some((p) => sameStation(p, prev as Station)) && !pinned.some((p) => sameStation(p, s));
              return (
                <div key={s.id}>
                  {showDivider && (
                    <div style={{ padding: "6px 8px 2px", fontSize: 10, color: "var(--text-dim)" }}>精选电台</div>
                  )}
                  <div className="pi-radio-row" style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: 8, background: current ? "var(--bg-selected)" : "transparent" }}>
                    <button
                      onClick={() => void play(s)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                        border: "none",
                        background: "transparent",
                        color: current ? "var(--accent)" : "var(--text)",
                        padding: "6px 8px",
                        cursor: "pointer",
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {isMatch ? "🔎 " : ""}
                        {s.name}
                      </div>
                      {(s.description || s.provider) && (
                        <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.description || s.provider}</div>
                      )}
                    </button>
                    <button
                      onClick={() => togglePin(s)}
                      title={isPinned(s) ? "取消收藏" : "收藏"}
                      style={{ ...iconBtn, color: isPinned(s) ? "var(--accent)" : "var(--text-dim)", width: 22, height: 22 }}
                    >
                      {isPinned(s) ? "★" : "☆"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: "6px 12px 10px", color: "var(--text-dim)", fontSize: 10, borderTop: "1px solid var(--border)" }}>直播电台 · 搜索由 Radio Browser 提供</div>
        </div>
      )}

      <div
        style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 38,
          padding: "0 6px 0 10px",
          borderRadius: 19,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          boxShadow: "0 10px 24px -14px rgba(0,0,0,0.4)",
          maxWidth: "min(260px, calc(100vw - 32px))",
          color: "var(--text)",
          fontSize: 12,
        }}
      >
        <button className="pi-radio-btn" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "打开网络电台" : "收起网络电台"} style={{ ...iconBtn, width: "auto", height: 30, gap: 8, padding: "0 6px", maxWidth: 180 }}>
          <span style={{ fontSize: 15 }}>📻</span>
          {playing && (
            <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 14 }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 3,
                    background: "var(--accent)",
                    borderRadius: 2,
                    height: 6 + i * 3,
                    animation: "pi-radio-eq 900ms ease-in-out infinite alternate",
                    animationDelay: `${i * 140}ms`,
                  }}
                />
              ))}
            </span>
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{station.name}</span>
        </button>
        <button className="pi-radio-btn" onClick={toggle} title={playing ? "暂停" : "播放"} style={iconBtn}>
          {playing ? "⏸" : "▶"}
        </button>
      </div>
    </div>
  );
}

const iconBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  padding: 0,
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
};
