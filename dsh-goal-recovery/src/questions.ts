import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type { RecoveryNotice } from "./recovery.ts";

const QUESTION_ID = "goal-recovery";

export function recoveryQuestion(
  notice: RecoveryNotice,
  agent: Agent,
  signal: AbortSignal,
): AskUserQuestionRequest {
  if (notice.kind === "round-limit") {
    return {
      questions: [{
        id: QUESTION_ID,
        header: "Goal round limit",
        question: `Goal stopped after ${notice.roundsStarted}/${notice.maxGoalRounds} rounds.`,
        detail: "Increase the goal's maxGoalRounds before resuming if more work is authorized.",
        options: [{ label: "Acknowledge" }],
        multiSelect: false,
      }],
      agent,
      signal,
    };
  }

  return {
    questions: [{
      id: QUESTION_ID,
      header: "Goal paused",
      question: "This goal cannot continue automatically. What should DSH do?",
      detail: notice.interrupted
        ? "The previous turn was interrupted before completion. DSH preserved the goal and requires your approval before continuing."
        : "DSH preserved the active goal but disabled automatic continuation when the session resumed.",
      options: [{ label: "Resume goal" }, { label: "Leave paused" }],
      multiSelect: false,
    }],
    agent,
    signal,
  };
}

export function choseResume(answer: unknown): boolean {
  return recoveryDecision(answer, "resume-required") === "resume";
}

export function recoveryDecision(
  answer: unknown,
  kind: RecoveryNotice["kind"],
): "resume" | "left-paused" | "acknowledged" | "malformed" {
  if (!answer || typeof answer !== "object" || !Array.isArray((answer as { answers?: unknown }).answers)) {
    return "malformed";
  }
  const item = (answer as { answers: unknown[] }).answers.find((candidate) => {
    return !!candidate && typeof candidate === "object"
      && (candidate as { id?: unknown }).id === QUESTION_ID;
  });
  if (!item) return "malformed";
  const selected = (item as { selected?: unknown }).selected;
  if (!Array.isArray(selected)) return "malformed";

  if (kind === "resume-required") {
    if (selected.length === 0) return "left-paused";
    if (selected.length !== 1) return "malformed";
    if (selected[0] === "Resume goal") return "resume";
    if (selected[0] === "Leave paused") return "left-paused";
    return "malformed";
  }

  if (selected.length === 1 && selected[0] === "Acknowledge") return "acknowledged";
  return "malformed";
}
