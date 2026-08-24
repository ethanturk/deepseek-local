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
        header: "Goal stopped",
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
  if (!answer || typeof answer !== "object" || !Array.isArray((answer as { answers?: unknown }).answers)) {
    return false;
  }
  return (answer as { answers: unknown[] }).answers.some((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as { id?: unknown; selected?: unknown };
    return candidate.id === QUESTION_ID
      && Array.isArray(candidate.selected)
      && candidate.selected.includes("Resume goal");
  });
}
