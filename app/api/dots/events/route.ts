// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as server from "next/server";
import * as dot_events from "@/lib/dot-events";
export const dynamic = "force-dynamic";
async function GET(req) {
  const url = new URL(req.url);
  return server["NextResponse"].json({
    events: (0, dot_events["listDotEvents"])(url.searchParams.get("after") || undefined, 100)
  });
}
async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return server["NextResponse"].json({
    error: "text is empty"
  }, {
    status: 400
  });
  const event = (0, dot_events["appendDotEvent"])({
    type: body?.type === "dot_reply" ? "dot_reply" : "user_message",
    source: body?.source === "wechat" ? "wechat" : "pi-web",
    text,
    userId: typeof body?.userId === "string" ? body.userId : undefined,
    model: typeof body?.model === "string" ? body.model : undefined
  });
  return server["NextResponse"].json({
    event
  });
}
export { GET, POST };