import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type { RecoveryNotice } from "../src/recovery.ts";
import { choseResume, recoveryQuestion } from "../src/questions.ts";

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
      question: "Resume the paused goal?",
      detail: "The previous turn stopped unexpectedly after 2/8 rounds started.",
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
      question: "Resume the paused goal?",
      detail: "The session reopened with the goal paused after 2/8 rounds started.",
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
      header: "Goal stopped",
      question: "What would you like to do?",
      detail: "The goal used 8/8 rounds. Increase the configured limit before resuming.",
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
  ]) {
    assert.doesNotThrow(() => choseResume(answer));
    assert.equal(choseResume(answer), false);
  }
});
