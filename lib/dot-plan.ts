// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

function stripPlanJson(text) {
  return text.replace(/```(?:json|plan-json)\s*[\s\S]*?```/gi, "").replace(/<PLAN_JSON>[\s\S]*?<\/PLAN_JSON>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}
function parsePlanJson(text) {
  const match = text.match(/```(?:json|plan-json)\s*([\s\S]*?)```/i) ?? text.match(/<PLAN_JSON>\s*([\s\S]*?)\s*<\/PLAN_JSON>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed.goal !== "string" || !Array.isArray(parsed.tasks)) return null;
    const tasks = parsed.tasks.filter(task => task && typeof task.title === "string" && typeof task.projectPath === "string");
    return {
      goal: parsed.goal,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tasks,
      needsUserDecision: Array.isArray(parsed.needsUserDecision) ? parsed.needsUserDecision.filter(item => typeof item === "string") : [],
      nextCheckAt: typeof parsed.nextCheckAt === "string" ? parsed.nextCheckAt : undefined
    };
  } catch {
    return null;
  }
}
export { parsePlanJson, stripPlanJson };