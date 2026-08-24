import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type { RecoveryNotice } from "../src/recovery.ts";
import { choseResume, recoveryDecision, recoveryQuestion } from "../src/questions.ts";

const agent = {} as Agent;
const signal = new AbortController().signal;
const ref = { id: "goal-1", revision: 3 } as RecoveryNotice["ref"];

function notice(overrides: Partial<Extract<RecoveryNotice, { kind: "resume-required" }>> = {}): RecoveryNotice {
  return {
    kind: "resume-required",
    ref,
    roundsStarted: 2,
    maxGoalRounds: 8,
    interrupted: false,
    ...overrides,
  };
}

function request(noticeValue: RecoveryNotice): AskUserQuestionRequest {
  return recoveryQuestion(noticeValue, agent, signal);
}

test("renders interrupted resume request with native question fields", () => {
  assert.deepEqual(request(notice({ interrupted: true })), {
    questions: [{
      id: "goal-recovery",
      header: "Goal paused",
      question: "This goal cannot continue automatically. What should DSH do?",
      detail: "The previous turn was interrupted before completion. DSH preserved the goal and requires your approval before continuing.",
      options: [{ label: "Resume goal" }, { label: "Leave paused" }],
      multiSelect: false,
    }],
    agent,
    signal,
  });
});

test("renders ordinary resume request with reopened-session detail", () => {
  assert.deepEqual(request(notice()), {
    questions: [{
      id: "goal-recovery",
      header: "Goal paused",
      question: "This goal cannot continue automatically. What should DSH do?",
      detail: "DSH preserved the active goal but disabled automatic continuation when the session resumed.",
      options: [{ label: "Resume goal" }, { label: "Leave paused" }],
      multiSelect: false,
    }],
    agent,
    signal,
  });
});

test("renders round-limit request with acknowledgement only", () => {
  assert.deepEqual(request({ kind: "round-limit", ref, roundsStarted: 8, maxGoalRounds: 8 }), {
    questions: [{
      id: "goal-recovery",
      header: "Goal round limit",
      question: "Goal stopped after 8/8 rounds.",
      detail: "Increase the goal's maxGoalRounds before resuming if more work is authorized.",
      options: [{ label: "Acknowledge" }],
      multiSelect: false,
    }],
    agent,
    signal,
  });
});

test("choseResume accepts only the exact recovery answer", () => {
  assert.equal(choseResume({ answers: [{ id: "goal-recovery", selected: ["Resume goal"] }] }), true);
  assert.equal(choseResume({ answers: [{ id: "other", selected: ["Resume goal"] }] }), false);
  assert.equal(choseResume({ answers: [{ id: "goal-recovery", selected: ["resume goal"] }] }), false);
});

test("choseResume safely rejects malformed and non-resume answers", () => {
  for (const answer of [
    undefined,
    null,
    {},
    { answers: undefined },
    { answers: "bad" },
    { answers: [{ id: "goal-recovery" }] },
    { answers: [{ id: "goal-recovery", selected: "Resume goal" }] },
    { answers: [{ id: "goal-recovery", selected: [] }] },
    { answers: [{ id: "goal-recovery", selected: ["Leave paused"] }] },
    { answers: [{ id: "goal-recovery", selected: ["Acknowledge"] }] },
    { answers: [{ id: "goal-recovery", selected: [], custom: "Resume goal" }] },
  ]) {
    assert.doesNotThrow(() => choseResume(answer));
    assert.equal(choseResume(answer), false);
  }
});

test("recoveryDecision validates notice-specific option labels", () => {
  const selected = (label: string) => ({ answers: [{ id: "goal-recovery", selected: [label] }] });
  const empty = { answers: [{ id: "goal-recovery", selected: [], custom: "anything" }] };

  assert.equal(recoveryDecision(selected("Resume goal"), "resume-required"), "resume");
  assert.equal(recoveryDecision(selected("Leave paused"), "resume-required"), "left-paused");
  assert.equal(recoveryDecision(empty, "resume-required"), "left-paused");
  assert.equal(recoveryDecision(selected("bogus"), "resume-required"), "malformed");
  assert.equal(recoveryDecision(selected("Acknowledge"), "round-limit"), "acknowledged");
  assert.equal(recoveryDecision(empty, "round-limit"), "malformed");
  assert.equal(recoveryDecision(selected("bogus"), "round-limit"), "malformed");
});
