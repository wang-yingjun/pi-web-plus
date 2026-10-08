"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_INPUT_ENABLED_KEY,
  composeTranscript,
  readStoredToggle,
  readStoredVoiceInputLocale,
  type VoiceLocale,
} from "@/lib/voice";

// Minimal structural types for the Web Speech API's SpeechRecognition, which
// TypeScript's DOM lib does not ship by default.
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface UseVoiceInputOptions {
  /**
   * Speech-recognition language (a BCP-47 tag). Defaults to the persisted
   * setting, which is Simplified Chinese out of the box.
   */
  locale?: VoiceLocale;
  /** Called with the latest full transcript while the user speaks. */
  onTranscript: (text: string) => void;
  /** Called on a terminal recognition error with a short reason code. */
  onError?: (code: string) => void;
}

export interface UseVoiceInputResult {
  supported: boolean;
  listening: boolean;
  /** Live interim text, useful for a "listening…" hint. */
  interim: string;
  start: () => void;
  stop: () => void;
  /** Clears accumulated finals/interim without stopping the engine. */
  reset: () => void;
  toggle: () => void;
}

/**
 * Browser-native speech recognition built on the Web Speech API. The hook owns
 * one SpeechRecognition instance, restarts it across the engine's automatic
 * end events while the user is still "listening", and forwards the composed
 * transcript to the caller.
 */
export function useVoiceInput({ locale = readStoredVoiceInputLocale(), onTranscript, onError }: UseVoiceInputOptions): UseVoiceInputResult {
  const supported = typeof window !== "undefined" && getRecognitionConstructor() !== null;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Whether the user wants to be listening. The engine fires `onend` on its own
  // (silence timeouts, tab switches), and we only restart while this is true.
  const wantListeningRef = useRef(false);
  const finalTranscriptRef = useRef("");
  // Finalized text from engine sessions that already ended. The engine resets
  // its own result list on every (re)start, so this carries earlier text over.
  const sessionBaseRef = useRef("");
  // Results are only accepted between onstart and onend. A late final from a
  // session that already ended would otherwise be appended a second time.
  const activeRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const localeRef = useRef<VoiceLocale>(locale);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;
  localeRef.current = locale;

  const ensureRecognition = useCallback((): SpeechRecognitionLike | null => {
    if (recognitionRef.current) return recognitionRef.current;
    const Ctor = getRecognitionConstructor();
    if (!Ctor) return null;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      activeRef.current = true;
      sessionBaseRef.current = finalTranscriptRef.current;
      setListening(true);
    };
    recognition.onresult = (event) => {
      // A result arriving after the engine ended belongs to a previous session;
      // dropping it stops the same words being added twice across a pause.
      if (!activeRef.current) return;
      // Rebuild the current session's finals from the engine's own result list
      // instead of appending, so a re-delivered final is idempotent.
      let sessionFinal = "";
      let interimText = "";
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          sessionFinal += transcript;
        } else {
          interimText += transcript;
        }
      }
      const finalText = sessionBaseRef.current + sessionFinal;
      finalTranscriptRef.current = finalText;
      setInterim(interimText);
      const composed = composeTranscript(finalText, interimText);
      if (composed.trim()) onTranscriptRef.current(composed);
    };
    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are routine; anything else is worth surfacing.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        onErrorRef.current?.(event.error);
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantListeningRef.current = false;
        setListening(false);
      }
    };
    recognition.onend = () => {
      activeRef.current = false;
      if (wantListeningRef.current) {
        // The engine stopped on its own; start a fresh utterance so a short
        // pause does not end the whole dictation session.
        try {
          recognition.start();
          return;
        } catch {
          // start() throws if a previous start is still settling; fall through.
        }
      }
      setListening(false);
    };

    recognitionRef.current = recognition;
    return recognition;
  }, []);

  const start = useCallback(() => {
    const recognition = ensureRecognition();
    if (!recognition) return;
    recognition.lang = localeRef.current;
    finalTranscriptRef.current = "";
    sessionBaseRef.current = "";
    setInterim("");
    wantListeningRef.current = true;
    try {
      recognition.start();
    } catch {
      // Already started — treat the click as idempotent.
    }
  }, [ensureRecognition]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Not started; nothing to stop.
      }
    }
    setInterim("");
    setListening(false);
  }, []);

  const reset = useCallback(() => {
    finalTranscriptRef.current = "";
    sessionBaseRef.current = "";
    setInterim("");
    // Drop the engine's buffered results too, so text we just consumed (e.g.
    // after a hands-free auto-send) cannot be re-delivered into the next turn.
    const recognition = recognitionRef.current;
    if (recognition && wantListeningRef.current) {
      try {
        recognition.abort();
      } catch {
        // Not started; nothing to reset.
      }
    }
  }, []);

  const toggle = useCallback(() => {
    if (wantListeningRef.current) stop();
    else start();
  }, [start, stop]);

  // Keep the recognition language in sync when the setting changes.
  useEffect(() => {
    const recognition = recognitionRef.current;
    if (recognition) recognition.lang = locale;
  }, [locale]);

  // Abort recognition when the hook unmounts or the tab is hidden mid-dictation.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden" && wantListeningRef.current) stop();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      wantListeningRef.current = false;
      activeRef.current = false;
      const recognition = recognitionRef.current;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.onstart = null;
        try {
          recognition.abort();
        } catch {
          // Ignore teardown races.
        }
      }
      recognitionRef.current = null;
    };
  }, [stop]);

  return { supported, listening, interim, start, stop, reset, toggle };
}

/** Reads the persisted "voice input" toggle, defaulting to off. */
export function readVoiceInputEnabled(): boolean {
  return readStoredToggle(VOICE_INPUT_ENABLED_KEY, true);
}
