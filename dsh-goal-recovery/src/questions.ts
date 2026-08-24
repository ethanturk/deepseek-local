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
        question: "What would you like to do?",
        detail: `The goal used ${notice.roundsStarted}/${notice.maxGoalRounds} rounds. Increase the configured limit before resuming.`,
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
      question: "Resume the paused goal?",
      detail: notice.interrupted
        ? `The previous turn stopped unexpectedly after ${notice.roundsStarted}/${notice.maxGoalRounds} rounds started.`
        : `The session reopened with the goal paused after ${notice.roundsStarted}/${notice.maxGoalRounds} rounds started.`,
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
