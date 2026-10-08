import assert from "node:assert/strict";
import test from "node:test";

import { nextBranchSessionName } from "./session-branch-name.ts";

test("names the first branch with a -2 suffix", () => {
  assert.equal(nextBranchSessionName("车有谱助手", ["车有谱助手", "另一个会话"]), "车有谱助手-2");
});

test("numbers a branch taken from a branch", () => {
  assert.equal(
    nextBranchSessionName("车有谱助手-2", ["车有谱助手", "车有谱助手-2"]),
    "车有谱助手-3",
  );
});

test("skips suffixes that are already taken", () => {
  assert.equal(
    nextBranchSessionName("车有谱助手", ["车有谱助手-2", "车有谱助手-3"]),
    "车有谱助手-4",
  );
});

test("ignores untitled and blank existing sessions", () => {
  assert.equal(nextBranchSessionName("会话", [undefined, "", "  "]), "会话-2");
});

test("returns undefined when the source has no name", () => {
  assert.equal(nextBranchSessionName("", ["会话"]), undefined);
  assert.equal(nextBranchSessionName("   ", []), undefined);
});
