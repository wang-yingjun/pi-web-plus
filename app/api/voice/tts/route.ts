import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { Readable } from "node:stream";
import { installEdgeTtsSynthUrl } from "@/lib/edge-tts-endpoint";

export const runtime = "nodejs";

// Point msedge-tts at Microsoft's current synthesis endpoint; the legacy one it
// defaults to answers every handshake with HTTP 403, which is what made replies
// fall back to the browser's built-in voices. See lib/edge-tts-endpoint.ts.
installEdgeTtsSynthUrl();

/** Microsoft Edge neural voices, exposed through the Edge Read Aloud API for free. */
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$/i;
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const MAX_TEXT_LENGTH = 2000;

/**
 * Warm connection pool keyed by voice. Opening the Edge WebSocket costs
 * several hundred milliseconds, so a live connection is reused to keep latency
 * to synthesis time. An instance handles one request at a time; a request that
 * arrives while the warm instance is busy gets a temporary connection, which is
 * closed as soon as its stream ends.
 *
 * Note: do NOT add a lock here. A synthesis stream that stalls without emitting
 * `end`/`error` would hold the lock forever and wedge every later request for
 * that voice. Microsoft's `speech.platform.bing.com` endpoint accepts the
 * extra connection, so concurrency needs no serialization.
 */
interface PoolEntry {
  tts: MsEdgeTTS;
  inflight: number;
}

interface Lease {
  tts: MsEdgeTTS;
  /** Return the connection to the pool (or close a temporary one). Idempotent. */
  release: () => void;
  /** Drop the broken connection so the next request opens a fresh one. */
  invalidate: () => void;
}

const pool = new Map<string, PoolEntry>();

async function acquireTTS(voice: string): Promise<Lease> {
  const entry = pool.get(voice);
  if (entry && entry.inflight === 0) {
    entry.inflight += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      entry.inflight = Math.max(0, entry.inflight - 1);
    };
    return {
      tts: entry.tts,
      release: finish,
      invalidate: () => {
        if (pool.get(voice) === entry) pool.delete(voice);
        try { entry.tts.close(); } catch { /* already closed */ }
        finish();
      },
    };
  }
  // Either no connection yet, or the warm one is busy. Set up a standalone
  // instance; it becomes the pool's warm connection only if the slot is still
  // empty once metadata is ready.
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  if (!entry && !pool.has(voice)) {
    const created: PoolEntry = { tts, inflight: 1 };
    pool.set(voice, created);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      created.inflight = Math.max(0, created.inflight - 1);
    };
    return {
      tts,
      release: finish,
      invalidate: () => {
        if (pool.get(voice) === created) pool.delete(voice);
        try { tts.close(); } catch { /* already closed */ }
        finish();
      },
    };
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { tts.close(); } catch { /* already closed */ }
  };
  return { tts, release: finish, invalidate: finish };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400 });
  }
  const payload = body as { text?: unknown; voice?: unknown; rate?: unknown };
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return new Response(JSON.stringify({ error: "text is required" }), { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return new Response(JSON.stringify({ error: `text exceeds ${MAX_TEXT_LENGTH} characters` }), { status: 413 });
  }
  const voice = typeof payload?.voice === "string" && VOICE_PATTERN.test(payload.voice)
    ? payload.voice
    : DEFAULT_VOICE;
  // Relative SSML rate as a percentage string, e.g. 1.2 → "+20%".
  const ratePct = Number(payload?.rate);
  const rate = Number.isFinite(ratePct) && ratePct >= -50 && ratePct <= 100
    ? `${ratePct >= 0 ? "+" : ""}${Math.round(ratePct)}%`
    : "+0%";

  let lease: Lease;
  try {
    lease = await acquireTTS(voice);
  } catch (error) {
    // Connection/setup failure (network, rate limit, bad voice) — the client
    // falls back to a browser voice, as with any failed synthesis.
    console.error("Edge TTS connection failed:", error);
    return new Response(JSON.stringify({ error: "speech synthesis failed" }), { status: 502 });
  }
  try {
    const { audioStream } = lease.tts.toStream(text, { rate });
    audioStream.on("end", () => lease.release());
    audioStream.on("close", () => lease.release());
    audioStream.on("error", () => lease.invalidate());
    request.signal.addEventListener("abort", () => {
      audioStream.destroy();
      lease.release();
    });
    return new Response(Readable.toWeb(audioStream) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    lease.invalidate();
    console.error("Edge TTS synthesis failed:", error);
    return new Response(JSON.stringify({ error: "speech synthesis failed" }), { status: 502 });
  }
}
