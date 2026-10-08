/**
 * One shared AudioContext for everything that plays sound (completion tone,
 * neural TTS). Contexts created outside a user gesture start suspended, so a
 * single shared instance lets any user interaction (e.g. the composer's
 * unlock call) resume audio for all consumers.
 */

type AudioContextCtor = typeof AudioContext;

function AudioContextClass(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

let shared: AudioContext | null = null;
// Whether a silent source has actually been started during a user gesture.
let primed = false;

export function getSharedAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (shared && shared.state !== "closed") return shared;
  const Ctor = AudioContextClass();
  if (!Ctor) return null;
  try {
    shared = new Ctor();
    primed = false;
  } catch {
    return null;
  }
  return shared;
}

/**
 * Unlock the shared context from a user gesture. Safari and iOS do not treat a
 * bare `resume()` as unlocked — an actual source must start while the gesture
 * is still being handled, or later programmatic playback stays silent.
 */
export function unlockSharedAudioContext(): void {
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  if (primed) return;
  primed = true;
  try {
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, 22050);
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Best-effort; playback retries resume() again later.
  }
}

/** Resume the shared context if it is suspended (best-effort). */
export function resumeSharedAudioContext(): void {
  const ctx = getSharedAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

/**
 * `decodeAudioData` that works with both the promise signature and the older
 * callback-only one Safari used.
 */
export function decodeAudioData(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const ok = (buffer: AudioBuffer) => {
      if (!settled) {
        settled = true;
        resolve(buffer);
      }
    };
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    try {
      const maybe = ctx.decodeAudioData(data, ok, fail) as unknown;
      if (maybe && typeof (maybe as Promise<AudioBuffer>).then === "function") {
        (maybe as Promise<AudioBuffer>).then(ok, fail);
      }
    } catch (error) {
      fail(error);
    }
  });
}
