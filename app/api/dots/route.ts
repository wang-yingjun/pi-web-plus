// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as server from "next/server";
import * as dots from "@/lib/dots";
import * as dot_events from "@/lib/dot-events";
import * as dot_state from "@/lib/dot-state";
export const dynamic = "force-dynamic";
async function GET() {
  try {
    const plans = (0, dot_state["listDotPlans"])();
    const activePlan = plans.find(plan => ["awaiting_confirmation", "approved", "running", "blocked"].includes(plan.status)) ?? plans[0] ?? null;
    return server["NextResponse"].json({
      dots: (0, dots["listDots"])(),
      root: (0, dots["getDotsRoot"])(),
      plan: activePlan,
      plans: plans.slice(0, 10),
      events: (0, dot_events["listDotEvents"])(undefined, 60)
    });
  } catch (error) {
    return server["NextResponse"].json({
      error: error instanceof Error ? error.message : String(error)
    }, {
      status: 500
    });
  }
}
async function POST(req) {
  try {
    const body = await req.json();
    const dir = typeof body?.dir === "string" ? body.dir : "";
    const reply = typeof body?.reply === "string" ? body.reply.trim() : "";
    if (!dir.startsWith((0, dots["getDotsRoot"])())) {
      return server["NextResponse"].json({
        error: "Invalid dot directory"
      }, {
        status: 400
      });
    }
    if (!reply) {
      return server["NextResponse"].json({
        error: "Reply text is empty"
      }, {
        status: 400
      });
    }
    (0, dots["appendDotReply"])(dir, reply);
    return server["NextResponse"].json({
      ok: true
    });
  } catch (error) {
    return server["NextResponse"].json({
      error: error instanceof Error ? error.message : String(error)
    }, {
      status: 500
    });
  }
}
export { GET, POST };