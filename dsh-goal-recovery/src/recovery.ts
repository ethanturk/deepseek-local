import type { GoalRef, GoalView } from "@deepseek-ai/dsh-goal";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

export type RecoveryNotice =
  | {
      kind: "resume-required";
      ref: GoalRef;
      roundsStarted: number;
      maxGoalRounds: number;
      terminalTurnSeq?: number;
      interrupted: boolean;
    }
  | {
      kind: "round-limit";
      ref: GoalRef;
      roundsStarted: number;
      maxGoalRounds: number;
      terminalTurnSeq?: number;
    };

export function latestTurnEnd(events: readonly SessionEvent[]): SessionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn/end") return events[index];
  }
  return undefined;
}

export function classifyRecovery(
  goal: GoalView | undefined,
  latestEnd: SessionEvent | undefined,
): RecoveryNotice | undefined {
  if (!goal) return undefined;
  const ref = { id: goal.id, revision: goal.revision };
  const atLimit = goal.roundsStarted >= goal.maxGoalRounds;
  const terminal = latestEnd?.type === "turn/end" ? { terminalTurnSeq: latestEnd.seq } : {};

  if (goal.phase === "blocked" && goal.blockedReason?.code === "round-limit") {
    return { kind: "round-limit", ref, roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds, ...terminal };
  }
  if (goal.phase !== "active" || goal.activation !== "disarmed") return undefined;
  if (atLimit) {
    return { kind: "round-limit", ref, roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds, ...terminal };
  }
  return {
    kind: "resume-required",
    ref,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    ...terminal,
    interrupted: latestEnd?.type === "turn/end" && latestEnd.data.reason.kind === "interrupted",
  };
}

export function recoveryNoticeKey(notice: RecoveryNotice): string {
  return `${notice.kind}:${notice.ref.id}:${notice.ref.revision}:${notice.terminalTurnSeq ?? "none"}`;
}
