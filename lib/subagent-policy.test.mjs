import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const p = await createJiti(import.meta.url).import("./subagent-policy.ts");

test("missing or unauthorized session fails closed; four attempts persist across calls", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-policy-"));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const path = join(dir,"policy.json");
  assert.throws(() => p.reserveSubagentDispatch("a",path), /no readable/);
  writeFileSync(path, JSON.stringify({authorizedSessions:["a","b"]}));
  assert.throws(() => p.reserveSubagentDispatch("x",path), /not explicitly authorized/);
  for(let i=0;i<4;i++) p.reserveSubagentDispatch("a",path);
  assert.throws(() => p.reserveSubagentDispatch("a",path), /budget exhausted/);
  p.reserveSubagentDispatch("b",path);
  writeFileSync(path, JSON.stringify({authorizedSessions:[]}));
  assert.throws(() => p.assertAuthorizedSession("b",path), /not explicitly authorized/);
});
test("reject inherited and premium models, overrides, and excessive thinking", () => {
  assert.throws(() => p.approvedSubagentModel(), /inheritance forbidden/);
  assert.throws(() => p.approvedSubagentModel("openai-codex/gpt-6.2-sol"), /approved role model/);
  assert.throws(() => p.approvedSubagentModel("ark/deepseek-v4.1-flash","openai-codex/gpt-6.2-sol"), /override forbidden/);
  assert.equal(p.approvedSubagentModel("ark/glm-5.3"),"ark/glm-5.3");
  assert.equal(p.approvedSubagentThinking(),"low");
  assert.throws(() => p.approvedSubagentThinking("high"), /exceeds/);
  assert.throws(() => p.approvedSubagentThinking("low","high"), /override forbidden/);
  assert.equal(p.boundedSubagentTurns(),12);
  assert.equal(p.boundedSubagentTurns(100),12);
  assert.equal(p.boundedSubagentTurns(3),3);
  assert.equal(p.MAX_CONCURRENT,2);
});


test("task permission defaults to single, is isolated and revocable", () => {
  assert.equal(p.getTaskSubagentMode("p1-a"),"single");
  assert.equal(p.parseSubagentMode(undefined),"single");
  assert.throws(() => p.parseSubagentMode("anything"));
  p.setTaskSubagentMode("p1-a","approval");
  assert.equal(p.getTaskSubagentMode("p1-a"),"approval");
  assert.equal(p.getTaskSubagentMode("p1-b"),"single");
  p.setTaskSubagentMode("p1-a","single");
  assert.equal(p.getTaskSubagentMode("p1-a"),"single");
});
