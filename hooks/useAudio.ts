"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { getSharedAudioContext, installAudioUnlockOnFirstGesture, unlockSharedAudioContext } from "@/lib/audio-context";

function playTone(ctx: AudioContext) {
  const now = ctx.currentTime;
  const freqs = [523.25, 659.25];
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}

function playToneNative(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  // Same two-note chime as playTone (C5 then E5, the second starting 0.18s
  // in), rendered to a WAV and played through a native <audio> element so
  // Safari's unreliable Web Audio output route is not involved.
  const sampleRate = 22050;
  const notes = [
    { freq: 523.25, start: 0, duration: 0.45 },
    { freq: 659.25, start: 0.18, duration: 0.45 },
  ];
  const duration = Math.max(...notes.map((note) => note.start + note.duration));
  const samples = Math.ceil(sampleRate * duration);
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const write = (offset: number, text: string) => {
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    let value = 0;
    for (const note of notes) {
      const elapsed = t - note.start;
      if (elapsed < 0 || elapsed > note.duration) continue;
      // Perceptible attack, exponential-ish release — mirrors the oscillator
      // version's gain ramps so the chime keeps its original character.
      const attack = Math.min(1, elapsed / 0.02);
      const release = Math.exp(-elapsed * 9);
      const envelope = 0.18 * attack * release;
      value += Math.sin(2 * Math.PI * note.freq * elapsed) * envelope;
    }
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * 32767, true);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const audio = new Audio(url);
  audio.volume = 1;
  return new Promise((resolve, reject) => {
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", () => { URL.revokeObjectURL(url); reject(new Error("native tone playback failed")); }, { once: true });
    void audio.play().catch(reject);
  });
}

export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("pi-sound-enabled");
    return stored === null ? true : stored === "true";
  });

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Any first interaction unlocks audio for every consumer, so a persisted
  // hands-free session is not silenced by the browser autoplay policy.
  useEffect(() => { installAudioUnlockOnFirstGesture(); }, []);

  // Reuse a single shared AudioContext so it can be resumed if the browser
  // autoplay policy suspends it (contexts created outside user gestures start
  // in "suspended" state and produce no sound).
  const getCtx = useCallback((): AudioContext | null => getSharedAudioContext(), []);

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return;
    // Start a silent source as well as resuming: Safari only counts the context
    // as unlocked once a source has run inside the user gesture.
    unlockSharedAudioContext();
  }, []);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    enabledRef.current = next;
    localStorage.setItem("pi-sound-enabled", String(next));
    setEnabled(next);
  }, [unlockAudio]);

  const playDone = useCallback(() => {
    if (!enabledRef.current) return;
    // Safari can report a running AudioContext while its oscillator output is
    // inaudible. Use the native media path first, matching neural MP3 output.
    void playToneNative().catch(() => {
      const ctx = getCtx();
      if (!ctx) return;
      const play = () => {
        try { playTone(ctx); } catch { /* AudioContext unavailable */ }
      };
      if (ctx.state === "suspended") {
        ctx.resume().then(play).catch(() => {});
      } else {
        play();
      }
    });
  }, [getCtx]);

  return { soundEnabled: enabled, onSoundToggle: toggle, playDoneSound: playDone, unlockAudio, soundEnabledRef: enabledRef };
}
