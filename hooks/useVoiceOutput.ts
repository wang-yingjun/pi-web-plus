"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_VOICE_RATE,
  VOICE_AUTO_SPEAK_KEY,
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
  onToggle: () => void;
  onAutoSpeakToggle: () => void;
  onRateChange: (rate: number) => void;
  speak: (text: string) => void;
  stop: () => void;
}

/**
 * Browser-native text-to-speech built on window.speechSynthesis. Long replies
 * are chunked so engines that truncate long utterances still read everything,
 * and the engine queues chunks so speaking continues across them.
 */
export function useVoiceOutput({ locale }: UseVoiceOutputOptions): UseVoiceOutputResult {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [enabled, setEnabled] = useState<boolean>(() => readStoredToggle(VOICE_OUTPUT_ENABLED_KEY, false));
  // Auto-speak defaults off: enabling voice output should not silently start
  // reading every assistant reply aloud. The user opts in from settings.
  const [autoSpeak, setAutoSpeak] = useState<boolean>(() => readStoredToggle(VOICE_AUTO_SPEAK_KEY, false));
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

  const stop = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    utteranceTokenRef.current += 1;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Nothing queued.
    }
    setSpeaking(false);
  }, []);

  /**
   * Queue `text` with an explicit voice (or auto-pick by text language).
   * `override` is used by the settings preview and bypasses the saved pick.
   */
  const speakWith = useCallback((text: string, override?: AvailableVoice | null) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const chunks = splitForSpeech(text);
    if (!chunks.length) return;
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
  }, []);

  const speak = useCallback((text: string) => {
    speakWith(text);
  }, [speakWith]);

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

  const onToggle = useCallback(() => {
    const next = !enabledRef.current;
    enabledRef.current = next;
    try {
      window.localStorage.setItem(VOICE_OUTPUT_ENABLED_KEY, String(next));
    } catch {
      // Persisting is best-effort.
    }
    setEnabled(next);
    if (!next) stop();
  }, [stop]);

  const onAutoSpeakToggle = useCallback(() => {
    setAutoSpeak((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(VOICE_AUTO_SPEAK_KEY, String(next));
      } catch {
        // Persisting is best-effort.
      }
      return next;
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
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // Ignore teardown races.
    }
  }, []);

  return {
    supported,
    enabled,
    autoSpeak,
    rate,
    speaking,
    onToggle,
    onAutoSpeakToggle,
    onRateChange,
    voices: availableVoices,
    selectedVoice,
    onVoiceChange,
    previewVoice,
    speak: speakNow,
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
