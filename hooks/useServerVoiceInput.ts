"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceLocale } from "@/lib/voice";

// VAD 参数：根据 opus 压缩后的正常块大小调整
const SILENCE_MS = 2000; // 停顿 2 秒后切段（比浏览器原生更长，避免频繁切断）
const SPEECH_WINDOW_BYTES = 800; // 最近 1 秒窗口超过 800B 视为语音
const SPEECH_ABOVE_QUIET = 2.0; // 必须是静音基线的 2 倍
const MAX_UTTERANCE_MS = 15000; // 15 秒兜底切段

interface UseServerVoiceInputOptions {
  locale: VoiceLocale;
  onTranscript: (text: string) => void;
  onError?: (code: string) => void;
  onAvailability: (available: boolean) => void;
}

export function useServerVoiceInput({ locale, onTranscript, onError, onAvailability }: UseServerVoiceInputOptions) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  
  const localeRef = useRef(locale);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  
  useEffect(() => { localeRef.current = locale; }, [locale]);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const wantListeningRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const chunkSizesRef = useRef<number[]>([]);
  const timerRef = useRef<number | null>(null);
  
  const sawSpeechRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const lastFlushAtRef = useRef(0);
  const quietWindowRef = useRef(300); // opus 静音基线约 300B/s
  const sendingRef = useRef(false);

  const teardown = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch {}
    }
    recorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    chunksRef.current = [];
    chunkSizesRef.current = [];
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    sendingRef.current = true;
    try {
      const form = new FormData();
      form.append("audio", blob, "utterance.webm");
      form.append("lang", localeRef.current);
      
      const res = await fetch("/api/voice/asr", { method: "POST", body: form });
      if (!res.ok) {
        if (res.status === 503) onAvailability(false);
        throw new Error(`ASR ${res.status}`);
      }
      
      const data = await res.json();
      if (data.text) {
        onTranscriptRef.current(data.text);
        setInterim("");
      }
    } catch (err) {
      console.error("[voice] transcribe failed:", err);
      onErrorRef.current?.("transcription-failed");
    } finally {
      sendingRef.current = false;
    }
  }, [onAvailability]);

  const flushUtterance = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    
    lastFlushAtRef.current = Date.now();
    const hadSpeech = sawSpeechRef.current;
    sawSpeechRef.current = false;
    
    recorder.onstop = () => {
      if (!wantListeningRef.current) return;
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      chunkSizesRef.current = [];
      
      // 只转写有内容的录音（> 2KB，约 2 秒静音的最小容器）
      if (hadSpeech && blob.size > 2000) {
        void transcribe(blob);
      }
      
      // 换一个新的 recorder 开始下一段
      const stream = streamRef.current;
      if (stream) {
        const next = createRecorder(stream);
        if (next) recorderRef.current = next;
        else onErrorRef.current?.("audio-capture");
      }
    };
    
    try { recorder.stop(); } catch {}
  }, [transcribe]);

  const createRecorder = useCallback((stream: MediaStream): MediaRecorder | null => {
    try {
      // 关键修复：显式指定 opus 编码，避免默认使用 PCM 导致巨块
      const options: MediaRecorderOptions = {};
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        options.mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/webm")) {
        options.mimeType = "audio/webm";
      }
      
      const recorder = new MediaRecorder(stream, options);
      
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size === 0) return;
        chunksRef.current.push(event.data);
        
        // VAD: 基于块大小的窗口能量检测
        chunkSizesRef.current.push(event.data.size);
        const sizes = chunkSizesRef.current;
        if (sizes.length > 24) sizes.shift();
        
        const window1s = sizes.slice(-4).reduce((a, b) => a + b, 0);
        
        // 动态静音基线
        if (window1s < quietWindowRef.current) {
          quietWindowRef.current = window1s;
        } else {
          quietWindowRef.current = Math.min(quietWindowRef.current * 1.02 + 8, window1s);
        }
        
        // 检测语音
        if (window1s > SPEECH_WINDOW_BYTES && window1s > quietWindowRef.current * SPEECH_ABOVE_QUIET) {
          sawSpeechRef.current = true;
          lastSpeechAtRef.current = Date.now();
        }
      });
      
      recorder.start(250); // 250ms 每块
      return recorder;
    } catch (err) {
      console.error("[voice] createRecorder failed:", err);
      return null;
    }
  }, []);

  const start = useCallback(() => {
    if (wantListeningRef.current) return;
    lastFlushAtRef.current = 0;
    
    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        onErrorRef.current?.("not-allowed");
        return;
      }
      
      if (!wantListeningRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      
      streamRef.current = stream;
      setInterim("");
      
      try {
        const recorder = createRecorder(stream);
        if (!recorder) throw new Error("recorder failed");
        recorderRef.current = recorder;
      } catch {
        teardown();
        onErrorRef.current?.("audio-capture");
        return;
      }
      
      wantListeningRef.current = true;
      setListening(true);
      sawSpeechRef.current = false;
      lastSpeechAtRef.current = Date.now();
      
      // 静音检测定时器
      timerRef.current = window.setInterval(() => {
        if (!recorderRef.current) return;
        const now = Date.now();
        
        // 检测到语音后，静音超过 SILENCE_MS 则切段
        if (sawSpeechRef.current && now - lastSpeechAtRef.current >= SILENCE_MS) {
          flushUtterance();
        }
        // 兜底：15 秒必须切一次
        else if (now - lastFlushAtRef.current >= MAX_UTTERANCE_MS 
                 && chunksRef.current.length > 0) {
          flushUtterance();
        }
      }, 250);
    })();
  }, [flushUtterance, teardown, createRecorder]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    setListening(false);
    setInterim("");
    teardown();
  }, [teardown]);

  const reset = useCallback(() => {
    chunksRef.current = [];
    chunkSizesRef.current = [];
    sawSpeechRef.current = false;
  }, []);

  const toggle = useCallback(() => {
    if (wantListeningRef.current) stop();
    else start();
  }, [start, stop]);

  // 探测服务端 ASR 是否可用
  useEffect(() => {
    let cancelled = false;
    fetch("/api/voice/asr")
      .then((res) => (res.ok ? res.json() : { available: false }))
      .then((data: { available?: boolean }) => {
        if (!cancelled) onAvailability(Boolean(data.available));
      })
      .catch(() => { if (!cancelled) onAvailability(false); });
    return () => { cancelled = true; };
  }, [onAvailability]);

  const supported = typeof window !== "undefined"
    && typeof MediaRecorder !== "undefined"
    && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden" && wantListeningRef.current) stop();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      wantListeningRef.current = false;
      teardown();
    };
  }, [stop, teardown]);

  return { supported, listening, interim, start, stop, reset, toggle };
}
