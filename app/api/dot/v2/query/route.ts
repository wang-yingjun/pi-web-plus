// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as server from "next/server";
import * as dot_query from "@/lib/dot-query";
import * as dot_orchestrator_v2 from "@/lib/dot-orchestrator-v2";
export const dynamic = "force-dynamic";
export const maxDuration = 900;
async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const source = body?.source === "wechat" ? "wechat" : "pi-web";
  if (!text) return server["NextResponse"].json({
    error: "text is empty"
  }, {
    status: 400
  });
  const intent = (0, dot_orchestrator_v2["classifyDotIntent"])(text);
  if (!["progress_query", "session_lookup", "status_query"].includes(intent)) {
    return server["NextResponse"].json({
      error: "该消息不是只读查询",
      intent
    }, {
      status: 409
    });
  }
  try {
    const reply = await (0, dot_query["handleReadOnlyDotQuery"])(text, intent, source);
    return server["NextResponse"].json({
      ok: true,
      intent,
      reply,
      readOnly: true
    });
  } catch (error) {
    return server["NextResponse"].json({
      error: error instanceof Error ? error.message : String(error),
      intent
    }, {
      status: 500
    });
  }
}
export { POST };