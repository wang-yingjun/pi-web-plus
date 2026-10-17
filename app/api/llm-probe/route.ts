// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as server from "next/server";
import * as request_security from "@/lib/request-security";
import * as llm_probe from "@/lib/llm-probe";
export const dynamic = "force-dynamic";
function intParam(value, fallback, min, max) {
  const parsed = value === null ? NaN : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
async function GET(req) {
  if (!(0, request_security["isApiRequestAllowed"])(req)) {
    return server["NextResponse"].json({
      error: "Untrusted API request"
    }, {
      status: 403
    });
  }
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "all" ? "all" : "enabled";
  const provider = url.searchParams.get("provider")?.trim() || undefined;
  const options = {
    scope,
    ...(provider ? {
      provider
    } : {}),
    timeoutMs: intParam(url.searchParams.get("timeout"), llm_probe["DEFAULT_PROBE_TIMEOUT_MS"], 3_000, 120_000),
    retries: intParam(url.searchParams.get("retries"), llm_probe["DEFAULT_PROBE_RETRIES"], 0, 5),
    concurrency: intParam(url.searchParams.get("concurrency"), llm_probe["DEFAULT_PROBE_CONCURRENCY"], 1, 12)
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed || req.signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const results = await (0, llm_probe["streamProbe"])(options, {
          onStart: targets => send("start", {
            total: targets.length,
            targets
          }),
          onResult: result => send("result", result)
        });
        const ok = results.filter(r => r.ok).length;
        send("done", {
          total: results.length,
          ok,
          failed: results.length - ok
        });
      } catch (error) {
        send("error", {
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a client abort.
        }
      }
    },
    cancel() {
      // Client disconnected; the in-flight probes finish server-side. They are
      // bounded by the per-request timeout, so this cannot leak for long.
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
export { GET };