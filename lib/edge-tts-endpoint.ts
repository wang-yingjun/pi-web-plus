import { MsEdgeTTS } from "msedge-tts";
import { generateSecMsGecV2 } from "./edge-tts-token";

/**
 * Endpoint and token handling for Microsoft Edge's "Read Aloud" synthesis
 * WebSocket.
 *
 * `msedge-tts` targets this host but generates the legacy v1 Sec-MS-GEC token,
 * which the service rejects with HTTP 403 as of the recent v2 rollout. Rather
 * than switch hosts — the newer `api.msedgeservices.com` endpoint rate-limits a
 * second concurrent connection with HTTP 429, which the speech queue hits
 * constantly while prefetching the next sentence — we keep the proven host and
 * only replace the token with the v2 form. See ./edge-tts-token.ts.
 */
export const EDGE_TTS_SYNTH_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
export const EDGE_TTS_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const EDGE_TTS_SEC_MS_GEC_VERSION = "2-143.0.3650.75";

export interface EdgeTtsSynthUrlParams {
  secMsGec: string;
  connectionId: string;
}

/**
 * Build the synthesis URL. Kept pure so it can be unit-tested without opening
 * a socket.
 */
export function buildEdgeTtsSynthUrl({ secMsGec, connectionId }: EdgeTtsSynthUrlParams): string {
  return (
    `${EDGE_TTS_SYNTH_BASE}?TrustedClientToken=${EDGE_TTS_TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${EDGE_TTS_SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${encodeURIComponent(connectionId)}`
  );
}

let installed = false;

/**
 * Replace `MsEdgeTTS`'s static URL builder with one that carries the v2 token.
 * The library calls `MsEdgeTTS.getSynthUrl()` internally from `_createClient()`,
 * so patching the base static is what reaches it. Idempotent: safe to call on
 * every route-module evaluation (hot reload).
 */
export function installEdgeTtsSynthUrl(): void {
  if (installed) return;
  // The SDK types mark the uuid helper private, but the runtime exposes it.
  const tts = MsEdgeTTS as unknown as {
    generateUUID: () => string;
    getSynthUrl: () => Promise<string>;
  };
  tts.getSynthUrl = async function getSynthUrl(): Promise<string> {
    return buildEdgeTtsSynthUrl({
      secMsGec: generateSecMsGecV2(),
      connectionId: tts.generateUUID(),
    });
  };
  installed = true;
}
