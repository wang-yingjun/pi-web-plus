"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSharedAudioContext, resumeSharedAudioContext } from "@/lib/audio-context";
import {
  DEFAULT_VOICE_RATE,
  EDGE_TTS_VOICES,
  VOICE_AUTO_SPEAK_KEY,
  VOICE_NEURAL_KEY,
  VOICE_OUTPUT_ENABLED_KEY,
  VOICE_OUTPUT_VOICE_KEY,
  VOICE_RATE_KEY,
  detectSpeechLocale,
  normalizeVoiceRate,
  readStoredToggle,
  readStoredVoiceSelection,
  resolveStoredVoice,
  splitForSpeech,
  voiceLocaleForAppLocale,
  type VoiceSelection,
} from "@/lib/voice";

/** A speech-synthesis voice exposed to the settings UI. */
export interface AvailableVoice {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
}

export interface UseVoiceOutputOptions {
  /** App locale (en, zh-CN, zh-TW) used to pick the speaking voice. */
  locale: string;
}

export interface UseVoiceOutputResult {
  supported: boolean;
  /** Master switch: read assistant replies aloud. */
  enabled: boolean;
  /** Only meaningful while enabled: speak automatically when a reply lands. */
  autoSpeak: boolean;
  /** When on, replies are read with Edge neural voices via the server. */
  neural: boolean;
  rate: number;
  speaking: boolean;
  /** Voices the browser exposes for the currently relevant languages. */
  voices: AvailableVoice[];
  /** The user-chosen voice, or null when the hook auto-picks per language. */
  selectedVoice: VoiceSelection | null;
  /** Pick a voice (null restores automatic selection). */
  onVoiceChange: (voice: AvailableVoice | null) => void;
  /** Read a short sample with a given voice without changing the setting. */
  previewVoice: (voice: AvailableVoice) => void;
  onToggle: (next?: boolean) => void;
  onAutoSpeakToggle: (next?: boolean) => void;
  onNeuralToggle: () => void;
  onRateChange: (rate: number) => void;
  speak: (text: string) => void;
  /** Appends text to the speech queue without interrupting current playback. */
  enqueueSpeech: (text: string) => void;
  /** Enqueues the final remainder and closes the queue (streaming speech done). */
  finishSpeechQueue: (remainder: string) => void;
  /** Text currently being spoken or queued, for microphone echo filtering. */
  getCurrentSpeechText: () => string;
  stop: () => void;
}

/**
 * Browser-native text-to-speech built on window.speechSynthesis. Long replies
 * are chunked so engines that truncate long utterances still read everything,
 * and the engine queues chunks so speaking continues across them.
 */
export function useVoiceOutput({ locale }: UseVoiceOutputOptions): UseVoiceOutputResult {
  const [enabled, setEnabled] = useState<boolean>(() => readStoredToggle(VOICE_OUTPUT_ENABLED_KEY, false));
  // Auto-speak defaults off: enabling voice output should not silently start
  // reading every assistant reply aloud. The user opts in from settings.
  const [autoSpeak, setAutoSpeak] = useState<boolean>(() => readStoredToggle(VOICE_AUTO_SPEAK_KEY, false));
  const [neural, setNeural] = useState<boolean>(() => readStoredToggle(VOICE_NEURAL_KEY, true));
  const [rate, setRate] = useState<number>(DEFAULT_VOICE_RATE);
  const [speaking, setSpeaking] = useState(false);
  const [voicesReady, setVoicesReady] = useState(false);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  // Monotonic token so a late `onend` from a cancelled utterance cannot clear
  // the speaking state of a newer one.
  const utteranceTokenRef = useRef(0);
  // Populated once the browser exposes its voice list. Looked up directly in
  // speak() so a voice that arrives late is still used.
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const [availableVoices, setAvailableVoices] = useState<AvailableVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<VoiceSelection | null>(() => readStoredVoiceSelection());
  const selectedVoiceRef = useRef<VoiceSelection | null>(selectedVoice);
  selectedVoiceRef.current = selectedVoice;
  const neuralRef = useRef(neural);
  neuralRef.current = neural;
  // The <audio> element used for Edge TTS playback, so stop() can cut it off.
  const neuralAudioRef = useRef<HTMLAudioElement | null>(null);
  // The Web Audio source used for Edge TTS playback (primary path).
  const neuralSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Streaming speech queue: `enqueueSpeech` appends while the agent generates;
  // a new generation (speak/stop) bumps the token, clears the queue and ends
  // the previous player loop.
  const speechQueueRef = useRef<string[]>([]);
  const speechQueueClosedRef = useRef(true);
  const speechQueueWakeRef = useRef<() => void>(() => {});
  // Explicit liveness flag: enqueue/finish (re)start the loop whenever it is
  // not running, independent of generation tokens (which only govern
  // interruption).
  const queueLoopAliveRef = useRef(false);
  // Sliding window of recently spoken text, for microphone echo filtering.
  const spokenHistoryRef = useRef("");
  // Text currently being spoken (neural current chunk or pending browser
  // utterances) — used for echo detection while the microphone stays open.
  const currentChunkRef = useRef("");
  const browserPendingRef = useRef<string[]>([]);

  // Restore the persisted speech rate once on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(VOICE_RATE_KEY);
      if (stored !== null) setRate(normalizeVoiceRate(stored));
    } catch {
      // localStorage unavailable; keep the default.
    }
  }, []);

  // The browser loads voices asynchronously; getVoices() returns [] until the
  // first `voiceschanged`. Without this a very first utterance has no voice to
  // pick and some engines fall back to a default-language (often English)
  // voice, which is why replies seemed to be read in the wrong language.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    let cancelled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const capture = () => {
      if (cancelled) return;
      let voices: SpeechSynthesisVoice[] = [];
      try {
        voices = synth.getVoices();
      } catch {
        voices = [];
      }
      voicesRef.current = voices;
      // Expose Chinese, English and Hong Kong voices for the picker, sorted by
      // language then name so the list is stable between reloads.
      const relevant = voices
        .filter((voice) => /^(zh|en)([-_]|$)/i.test(voice.lang ?? ""))
        .map((voice) => ({
          name: voice.name,
          lang: voice.lang,
          voiceURI: voice.voiceURI,
          localService: Boolean(voice.localService),
        }))
        .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
      setAvailableVoices(relevant);
      if (voices.length) setVoicesReady(true);
    };
    capture();
    synth.addEventListener?.("voiceschanged", capture);
    // Safari historically never fires voiceschanged; poll briefly as a fallback.
    if (!voicesRef.current.length) {
      let attempts = 0;
      fallbackTimer = setInterval(() => {
        capture();
        attempts += 1;
        if (voicesRef.current.length || attempts > 20) {
          if (fallbackTimer) clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
      }, 250);
    }
    return () => {
      cancelled = true;
      synth.removeEventListener?.("voiceschanged", capture);
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, []);

  /** Cut off the currently playing neural audio, if any. */
  const killNeuralAudio = useCallback(() => {
    const source = neuralSourceRef.current;
    if (source) {
      neuralSourceRef.current = null;
      try { source.stop(); } catch { /* not started */ }
    }
    const audio = neuralAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = ""; // fires the error listener, resolving the play promise
      neuralAudioRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    if (typeof window === "undefined") return;
    utteranceTokenRef.current += 1;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // Nothing queued.
    }
    // Drop any queued streaming speech and wake the player loop so it exits.
    speechQueueRef.current = [];
    speechQueueClosedRef.current = true;
    speechQueueWakeRef.current();
    browserPendingRef.current = [];
    killNeuralAudio();
    setSpeaking(false);
  }, [killNeuralAudio]);

  /**
   * Read `chunks` with Edge neural voices via the server, one chunk at a
   * time. The next chunk is prefetched while the current one plays, so
   * network time overlaps with playback. Falls back to the browser voice for
   * a chunk whose synthesis fails.
   */
  /** Fetch one chunk's audio from the Edge TTS route; null on any failure. */
  const fetchNeuralBlob = useCallback(async (chunk: string): Promise<Blob | null> => {
    const uiLocale = voiceLocaleForAppLocale(localeRef.current);
    const voice = EDGE_TTS_VOICES[detectSpeechLocale(chunk, uiLocale)] ?? EDGE_TTS_VOICES["zh-CN"];
    try {
      const response = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: chunk,
          voice,
          // Relative percentage, e.g. 1.2× → +20.
          rate: Math.round((rateRef.current - 1) * 100),
        }),
      });
      if (!response.ok) return null;
      return await response.blob();
    } catch {
      return null;
    }
  }, []);

  const playNeuralBlob = useCallback(async (blob: Blob, token: number): Promise<void> => {
    const fallback = () => new Promise<void>((resolve) => {
      const audio = new Audio(URL.createObjectURL(blob));
      neuralAudioRef.current = audio;
      const done = () => {
        audio.removeEventListener("ended", done);
        audio.removeEventListener("error", done);
        URL.revokeObjectURL(audio.src);
        if (neuralAudioRef.current === audio) neuralAudioRef.current = null;
        resolve();
      };
      audio.addEventListener("ended", done);
      audio.addEventListener("error", done);
      void audio.play().catch(done);
      if (utteranceTokenRef.current !== token) {
        // Generation was replaced while starting up; cut the audio immediately.
        audio.pause();
        audio.src = "";
        done();
      }
    });
    // Primary path: Web Audio. Once the shared context is running (unlocked
    // by any user gesture), playback is not subject to the per-element
    // autoplay policy that silently rejects HTMLAudioElement.play().
    const ctx = getSharedAudioContext();
    if (ctx) {
      resumeSharedAudioContext();
      try {
        const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (utteranceTokenRef.current !== token) return;
        if (ctx.state === "running") {
          await new Promise<void>((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.onended = () => {
              if (neuralSourceRef.current === source) neuralSourceRef.current = null;
              resolve();
            };
            neuralSourceRef.current = source;
            source.connect(ctx.destination);
            if (utteranceTokenRef.current !== token) {
              try { source.stop(); } catch { /* not started */ }
              resolve();
              return;
            }
            source.start();
          });
          return;
        }
      } catch {
        // decodeAudioData failed (bad data, Safari quirks); fall through to
        // the media-element fallback.
      }
    }
    await fallback();
  }, []);

  /**
   * Player loop for the speech queue. Drains the queue; while the queue is
   * open it sleeps between chunks so streaming appends continue playback
   * seamlessly. A newer generation (speak/stop) replaces the queue in place;
   * the loop adopts it and keeps running — it only exits when the queue is
   * empty AND closed.
   */
  const runQueueLoop = useCallback(() => {
    if (queueLoopAliveRef.current) return;
    queueLoopAliveRef.current = true;
    void (async () => {
      let token = utteranceTokenRef.current;
      setSpeaking(true);
      let prefetch: { text: string; promise: Promise<Blob | null> } | null = null;
      for (;;) {
        if (utteranceTokenRef.current !== token) {
          // A newer generation replaced the queue; adopt it and keep going.
          token = utteranceTokenRef.current;
          prefetch = null;
        }
        const chunk = speechQueueRef.current.shift();
        if (chunk === undefined) {
          if (speechQueueClosedRef.current) break;
          await new Promise<void>((resolve) => { speechQueueWakeRef.current = resolve; });
          continue;
        }
        currentChunkRef.current = chunk;
        spokenHistoryRef.current = `${spokenHistoryRef.current} ${chunk}`.slice(-1200);
        if (!prefetch || prefetch.text !== chunk) prefetch = null;
        const blobPromise = prefetch ? prefetch.promise : fetchNeuralBlob(chunk);
        prefetch = null;
        const next = speechQueueRef.current[0];
        if (next !== undefined) prefetch = { text: next, promise: fetchNeuralBlob(next) };
        const blob = await blobPromise;
        if (blob === null) {
          // Synthesis failed (server unreachable, Edge API down, …); read
          // this chunk with the browser voice and keep draining the queue.
          queueBrowserSpeech([chunk]);
        } else {
          await playNeuralBlob(blob, token);
        }
        currentChunkRef.current = "";
      }
      queueLoopAliveRef.current = false;
      currentChunkRef.current = "";
      // The browser fallback may still be speaking; keep `speaking` then.
      const synthSpeaking = typeof window !== "undefined"
        && (window.speechSynthesis?.speaking || window.speechSynthesis?.pending);
      if (!synthSpeaking) setSpeaking(false);
    })();
  }, [fetchNeuralBlob, playNeuralBlob]);

  /** Start a fresh speech generation, replacing whatever was playing. */
  const startNeuralGeneration = useCallback((chunks: string[]) => {
    utteranceTokenRef.current += 1;
    speechQueueRef.current = [...chunks];
    speechQueueClosedRef.current = false;
    killNeuralAudio();
    speechQueueWakeRef.current();
    runQueueLoop();
  }, [runQueueLoop, killNeuralAudio]);

  /** Append chunks to the browser speech engine without cancelling queued ones. */
  const enqueueBrowser = useCallback((chunks: string[]) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    if (!browserPendingRef.current.length) {
      // First append of a generation: invalidate any stale speech.
      utteranceTokenRef.current += 1;
    }
    setSpeaking(true);
    const uiLocale = voiceLocaleForAppLocale(localeRef.current);
    chunks.forEach((chunk) => {
      spokenHistoryRef.current = `${spokenHistoryRef.current} ${chunk}`.slice(-1200);
      browserPendingRef.current.push(chunk);
      const targetLocale = detectSpeechLocale(chunk, uiLocale);
      const voice = pickVoice(voicesRef.current, targetLocale);
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.rate = rateRef.current;
      utterance.lang = voice?.lang || targetLocale;
      if (voice) utterance.voice = voice;
      const settle = () => {
        const index = browserPendingRef.current.indexOf(chunk);
        if (index !== -1) browserPendingRef.current.splice(index, 1);
        if (!browserPendingRef.current.length) setSpeaking(false);
      };
      utterance.onend = settle;
      utterance.onerror = settle;
      synth.speak(utterance);
    });
  }, []);

  /** Appends sentences to the live queue without interrupting playback. */
  const enqueueSpeech = useCallback((text: string) => {
    const chunks = splitForSpeech(text, 90);
    if (!chunks.length) return;
    if (!neuralRef.current) {
      enqueueBrowser(chunks);
      return;
    }
    speechQueueRef.current.push(...chunks);
    speechQueueClosedRef.current = false;
    // Ensure a player loop is running (first streaming chunk, or the previous
    // loop drained and exited).
    speechQueueWakeRef.current();
    runQueueLoop();
  }, [runQueueLoop, enqueueBrowser]);

  /** Enqueues the final remainder and closes the queue. */
  const finishSpeechQueue = useCallback((remainder: string) => {
    const chunks = splitForSpeech(remainder, 90);
    if (!neuralRef.current) {
      enqueueBrowser(chunks);
      return;
    }
    speechQueueRef.current.push(...chunks);
    speechQueueClosedRef.current = true;
    speechQueueWakeRef.current();
    runQueueLoop();
  }, [runQueueLoop, enqueueBrowser]);

  /** Text currently being spoken or queued, plus a recent-history window —
   * used by the microphone input to filter the assistant's own voice (echo). */
  const getCurrentSpeechText = useCallback(() => (
    currentChunkRef.current
    + speechQueueRef.current.join("")
    + browserPendingRef.current.join("")
    + spokenHistoryRef.current
  ), []);

  /**
   * Queue `text` with an explicit voice (or auto-pick by text language).
   * `override` is used by the settings preview and bypasses the saved pick.
   */
  const speakWith = useCallback((text: string, override?: AvailableVoice | null) => {
    if (typeof window === "undefined") return;
    // Neural voices read better in short sentence-sized pieces, and smaller
    // chunks mean the first audio starts sooner.
    const chunks = splitForSpeech(text, neuralRef.current ? 90 : 220);
    if (!chunks.length) return;
    if (neuralRef.current) {
      startNeuralGeneration(chunks);
      return;
    }
    if (!("speechSynthesis" in window)) return;
    queueBrowserSpeech(chunks, override);
  }, [startNeuralGeneration]);

  /** Browser-native utterance queue; extracted so neural fallback can reuse it. */
  function queueBrowserSpeech(chunks: string[], override?: AvailableVoice | null) {
    if (!("speechSynthesis" in window)) return;
    const text = chunks.join(" ");
    const synth = window.speechSynthesis;
    // A fresh request replaces whatever was still being read.
    utteranceTokenRef.current += 1;
    const token = utteranceTokenRef.current;
    try {
      synth.cancel();
    } catch {
      // Ignore; a subsequent speak() is still fine.
    }
    // Pick the language from the text, not the UI: an English voice reading
    // Chinese is what produced the earlier gibberish. The UI locale is only a
    // hint for which Chinese variant to prefer.
    const uiLocale = voiceLocaleForAppLocale(localeRef.current);
    const targetLocale = detectSpeechLocale(text, uiLocale);
    // Prefer an explicit pick (preview) or the user's saved voice; only then
    // fall back to auto-selecting a voice for the detected language. The saved
    // voice wins regardless of language so a deliberate choice is honoured.
    const saved = override ? null : resolveStoredVoice(voicesRef.current, selectedVoiceRef.current);
    const chosen = override
      ? voicesRef.current.find((candidate) => candidate.voiceURI === override.voiceURI) ?? null
      : saved;
    const voice = chosen ?? pickVoice(voicesRef.current, targetLocale);
    // Always set `lang` on every utterance, even when a matching voice exists.
    // Some engines ignore the voice and use `lang`; setting both keeps the
    // language correct in every case.
    const utteranceLang = chosen?.lang || (voice ? voice.lang : targetLocale);
    setSpeaking(true);
    chunks.forEach((chunk, index) => {
      spokenHistoryRef.current = `${spokenHistoryRef.current} ${chunk}`.slice(-1200);
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.rate = rateRef.current;
      utterance.lang = utteranceLang;
      if (voice) utterance.voice = voice;
      if (index === chunks.length - 1) {
        const settle = () => {
          if (utteranceTokenRef.current === token) setSpeaking(false);
        };
        utterance.onend = settle;
        utterance.onerror = settle;
      }
      synth.speak(utterance);
    });
  }

  const speak = useCallback((text: string) => {
    speakWith(text);
  }, [speakWith]);

  const onNeuralToggle = useCallback(() => {
    setNeural((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(VOICE_NEURAL_KEY, String(next));
      } catch {
        // Persisting is best-effort.
      }
      return next;
    });
  }, []);

  const onVoiceChange = useCallback((voice: AvailableVoice | null) => {
    const next: VoiceSelection | null = voice
      ? { name: voice.name, lang: voice.lang, voiceURI: voice.voiceURI }
      : null;
    setSelectedVoice(next);
    selectedVoiceRef.current = next;
    try {
      if (next) window.localStorage.setItem(VOICE_OUTPUT_VOICE_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(VOICE_OUTPUT_VOICE_KEY);
    } catch {
      // Persisting is best-effort.
    }
  }, []);

  // Preview bypasses the deferred-voices wait: the settings picker only exists
  // once voices are loaded, so it can speak immediately.
  const previewVoice = useCallback((voice: AvailableVoice) => {
    speakWith(PREVIEW_TEXT, voice);
  }, [speakWith]);

  // Deferred-speak request: if speak() is called before the browser has exposed
  // its voices, replay the payload once they arrive so nothing is read with the
  // wrong default voice. A single pending payload is kept (the latest one).
  const pendingSpeechRef = useRef<string | null>(null);
  const speakNow = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (!voicesRef.current.length && !voicesReady) {
      pendingSpeechRef.current = text;
      // Give the engine a brief moment; if voices never arrive, speak anyway so
      // the feature still works (with the engine default voice).
      setTimeout(() => {
        const pending = pendingSpeechRef.current;
        if (pending === null) return;
        pendingSpeechRef.current = null;
        speak(pending);
      }, 400);
      return;
    }
    pendingSpeechRef.current = null;
    speak(text);
  }, [speak, voicesReady]);

  // Flush a deferred payload as soon as voices become available.
  useEffect(() => {
    if (!voicesReady) return;
    const pending = pendingSpeechRef.current;
    if (pending === null) return;
    pendingSpeechRef.current = null;
    speak(pending);
  }, [voicesReady, speak]);

  const onToggle = useCallback((next?: boolean) => {
    const value = typeof next === "boolean" ? next : !enabledRef.current;
    enabledRef.current = value;
    try {
      window.localStorage.setItem(VOICE_OUTPUT_ENABLED_KEY, String(value));
    } catch {
      // Persisting is best-effort.
    }
    setEnabled(value);
    if (!value) stop();
  }, [stop]);

  const onAutoSpeakToggle = useCallback((next?: boolean) => {
    setAutoSpeak((current) => {
      const value = typeof next === "boolean" ? next : !current;
      try {
        window.localStorage.setItem(VOICE_AUTO_SPEAK_KEY, String(value));
      } catch {
        // Persisting is best-effort.
      }
      return value;
    });
  }, []);

  const onRateChange = useCallback((next: number) => {
    const normalized = normalizeVoiceRate(next);
    rateRef.current = normalized;
    setRate(normalized);
    try {
      window.localStorage.setItem(VOICE_RATE_KEY, String(normalized));
    } catch {
      // Persisting is best-effort.
    }
  }, []);

  // Cancel any in-flight speech when the component unmounts.
  useEffect(() => () => {
    utteranceTokenRef.current += 1;
    speechQueueRef.current = [];
    speechQueueClosedRef.current = true;
    speechQueueWakeRef.current();
    neuralSourceRef.current?.stop();
    neuralAudioRef.current?.pause();
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // Ignore teardown races.
    }
  }, []);

  return {
    supported: true,
    enabled,
    autoSpeak,
    neural,
    rate,
    speaking,
    onToggle,
    onAutoSpeakToggle,
    onNeuralToggle,
    onRateChange,
    voices: availableVoices,
    selectedVoice,
    onVoiceChange,
    previewVoice,
    speak: speakNow,
    enqueueSpeech,
    finishSpeechQueue,
    getCurrentSpeechText,
    stop,
  };
}

/** Spoken when previewing a voice in settings; short and language-neutral-ish. */
export const PREVIEW_TEXT = "你好，我是你的编程助手 Pi。很高兴为你服务，你觉得这个声音怎么样？";

/**
 * Choose the best available voice for a locale. Prefers an exact language
 * match, then a language-only match, and otherwise returns null so the
 * utterance falls back to the engine default for its `lang`.
 */
function pickVoice(voices: SpeechSynthesisVoice[], locale: string): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const target = locale.toLowerCase();
  const languageOnly = target.split("-")[0];
  const matches = (voice: SpeechSynthesisVoice, prefix: string) =>
    (voice.lang ?? "").toLowerCase().replace("_", "-").startsWith(prefix);
  // Prefer exact language matches, and among those a local (offline) voice,
  // which on most systems is the higher-quality default for that language.
  const exact = voices.filter((voice) => matches(voice, target));
  if (exact.length) return exact.find((voice) => voice.localService) ?? exact[0];
  const sameLanguage = voices.filter((voice) => matches(voice, languageOnly));
  if (sameLanguage.length) return sameLanguage.find((voice) => voice.localService) ?? sameLanguage[0];
  // No voice for this language: return null so the engine uses `lang` alone.
  // Returning a mismatched voice would read the text in the wrong language.
  return null;
}

/** Reads the persisted "voice output" master toggle, defaulting to off. */
export function readVoiceOutputEnabled(): boolean {
  return readStoredToggle(VOICE_OUTPUT_ENABLED_KEY, false);
}
