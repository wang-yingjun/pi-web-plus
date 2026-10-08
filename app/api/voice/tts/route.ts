import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { Readable } from "node:stream";

export const runtime = "nodejs";

/** Microsoft Edge neural voices, exposed through the Edge Read Aloud API for free. */
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$/i;
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const MAX_TEXT_LENGTH = 2000;

/**
 * Warm connection pool keyed by voice. Opening the Edge WebSocket costs
 * several hundred milliseconds, so reusing a live connection keeps per-request
 * latency to synthesis time only. An instance handles one request at a time;
 * concurrent requests get a fresh (temporary) instance.
 */
const pool = new Map<string, { tts: MsEdgeTTS; inflight: number }>();

async function acquireTTS(voice: string): Promise<MsEdgeTTS> {
  const entry = pool.get(voice);
  if (entry && entry.inflight === 0) {
    entry.inflight += 1;
    return entry.tts;
  }
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  if (!entry) {
    pool.set(voice, { tts, inflight: 1 });
  } else {
    // Warm instance busy: hand out a temporary one; it is closed after use.
    return tts;
  }
  return tts;
}

function releaseTTS(voice: string, tts: MsEdgeTTS) {
  const entry = pool.get(voice);
  if (entry && entry.tts === tts) {
    entry.inflight -= 1;
    return;
  }
  try { tts.close(); } catch { /* temporary instance */ }
}

function invalidateTTS(voice: string, tts: MsEdgeTTS) {
  const entry = pool.get(voice);
  try { tts.close(); } catch { /* already closed */ }
  if (entry && entry.tts === tts) pool.delete(voice);
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

  const tts = await acquireTTS(voice);
  try {
    const { audioStream } = tts.toStream(text, { rate });
    audioStream.on("end", () => releaseTTS(voice, tts));
    audioStream.on("error", () => invalidateTTS(voice, tts));
    request.signal.addEventListener("abort", () => {
      audioStream.destroy();
      releaseTTS(voice, tts);
    });
    return new Response(Readable.toWeb(audioStream) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    invalidateTTS(voice, tts);
    console.error("Edge TTS synthesis failed:", error);
    return new Response(JSON.stringify({ error: "speech synthesis failed" }), { status: 502 });
  }
}
