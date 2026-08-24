import assert from "node:assert/strict";
import test from "node:test";

import { classifyHeuristic } from "../src/heuristic.ts";

test("skill invocations do not receive the trivial-short penalty", () => {
  assert.equal(classifyHeuristic("Improve this branch."), "simple");
  assert.equal(classifyHeuristic("/improve Refactor and optimize"), "medium");
  assert.equal(classifyHeuristic("$improve Refactor and optimize"), "medium");
});

test("explicit escalation requests route to at least medium", () => {
  assert.equal(classifyHeuristic("Do this again, but escalate it."), "medium");
  assert.equal(classifyHeuristic("Escalation needed."), "medium");
});
