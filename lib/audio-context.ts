/**
 * One shared AudioContext for everything that plays sound (completion tone,
 * neural TTS). Contexts created outside a user gesture start suspended, so a
 * single shared instance lets any user interaction (e.g. the composer's
 * unlock call) resume audio for all consumers.
 */

let shared: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (shared && shared.state !== "closed") return shared;
  try {
    shared = new AudioContext();
  } catch {
    return null;
  }
  return shared;
}

/** Resume the shared context if it is suspended (best-effort). */
export function resumeSharedAudioContext(): void {
  const ctx = getSharedAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}
