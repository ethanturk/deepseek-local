import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoalRef, GoalView } from "@deepseek-ai/dsh-goal";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  classifyRecovery,
  latestTurnEnd,
  recoveryNoticeKey,
} from "../src/recovery.ts";

const goalId = "goal-1" as GoalRef["id"];

function goal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: goalId,
    revision: 3,
    objective: "ship it",
    phase: "active",
    roundsStarted: 2,
    maxGoalRounds: 8,
    createdAt: 1,
    updatedAt: 2,
    activation: "disarmed",
    ...overrides,
  };
}

function turnEnd(reason: "completed" | "interrupted" | "error"): SessionEvent<"turn/end"> {
  return {
    type: "turn/end",
    seq: 1,
    time: 1,
    data: reason === "error"
      ? { turn: 1, reason: { kind: "error", error: { message: "boom", code: "E" } } }
      : { turn: 1, reason: { kind: reason } },
  };
}

test("classifies disarmed active goal with capacity as resume-required", () => {
  assert.deepEqual(classifyRecovery(goal(), undefined), {
    kind: "resume-required",
    ref: { id: goalId, revision: 3 },
    roundsStarted: 2,
    maxGoalRounds: 8,
    interrupted: false,
  });
});

test("marks resume-required as interrupted when latest turn ended interrupted", () => {
  const notice = classifyRecovery(goal(), turnEnd("interrupted"));
  assert.equal(notice?.kind, "resume-required");
  assert.equal(notice && "interrupted" in notice ? notice.interrupted : undefined, true);
});

test("uses only the latest turn/end when older turns were interrupted", () => {
  const events: SessionEvent[] = [turnEnd("interrupted"), turnEnd("completed")];
  const latest = latestTurnEnd(events);
  assert.equal(latest?.type === "turn/end" ? latest.data.reason.kind : undefined, "completed");
  const notice = classifyRecovery(goal(), latest);
  assert.equal(notice && "interrupted" in notice ? notice.interrupted : undefined, false);
});

test("classifies blocked round-limit goal as round-limit", () => {
  assert.deepEqual(classifyRecovery(goal({ phase: "blocked", activation: "disarmed", blockedReason: { code: "round-limit", message: "done" } }), undefined), {
    kind: "round-limit",
    ref: { id: goalId, revision: 3 },
    roundsStarted: 2,
    maxGoalRounds: 8,
  });
});

test("classifies exhausted disarmed active goal as round-limit", () => {
  assert.equal(classifyRecovery(goal({ roundsStarted: 8 }), undefined)?.kind, "round-limit");
});

for (const phase of ["absent", "armed", "paused", "complete", "unrelated-blocked"] as const) {
  test(`does not notify for ${phase} goal state`, () => {
    const value = phase === "absent" ? undefined : goal({
      phase: phase === "unrelated-blocked" ? "blocked" : phase === "armed" ? "active" : phase,
      activation: phase === "armed" ? "armed" : "disarmed",
      blockedReason: phase === "unrelated-blocked" ? { code: "other", message: "other" } : undefined,
    });
    assert.equal(classifyRecovery(value, undefined), undefined);
  });
}

test("notice key changes with goal revision and notice kind, not event objects", () => {
  const notice = classifyRecovery(goal(), turnEnd("completed"));
  const revised = classifyRecovery(goal({ revision: 4 }), turnEnd("completed"));
  const interrupted = classifyRecovery(goal(), turnEnd("interrupted"));
  assert.ok(notice && revised && interrupted);
  assert.notEqual(recoveryNoticeKey(notice), recoveryNoticeKey(revised));
  assert.notEqual(recoveryNoticeKey(notice), recoveryNoticeKey({ ...notice, kind: "round-limit", maxGoalRounds: 8 }));
  assert.equal(recoveryNoticeKey(notice), recoveryNoticeKey(classifyRecovery(goal(), turnEnd("error"))!));
});
