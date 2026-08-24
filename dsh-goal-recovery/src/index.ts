import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { choseResume, recoveryQuestion } from "./questions.ts";
import {
  classifyRecovery,
  latestTurnEnd,
  recoveryNoticeKey,
  type RecoveryNotice,
} from "./recovery.ts";

export const name = "dsh-goal-recovery";
export const inject = ["agents", "goals", "userQuestions"];

interface PendingRecovery {
  readonly key: string;
  readonly controller: AbortController;
}

function safeError(error: unknown): { errorCode: string; errorMessage: string } {
  if (!error || typeof error !== "object") {
    return { errorCode: "UNKNOWN", errorMessage: String(error) };
  }
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  return {
    errorCode: typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.name === "string"
        ? candidate.name
        : "UNKNOWN",
    errorMessage: typeof candidate.message === "string" ? candidate.message : "Goal recovery failed",
  };
}

export function apply(ctx: Context): void {
  const logger = ctx.logger(name);
  const pendingByAgent = new WeakMap<Agent, PendingRecovery>();
  const disposedAgents = new WeakSet<Agent>();
  const controllers = new Set<AbortController>();
  let closed = false;

  function logFailure(event: string, notice: RecoveryNotice, error: unknown): void {
    const entry = {
      event,
      noticeKind: notice.kind,
      goalId: notice.ref.id,
      goalRevision: notice.ref.revision,
      roundsStarted: notice.roundsStarted,
      maxGoalRounds: notice.maxGoalRounds,
      ...safeError(error),
    };
    if (event === "goal-recovery/question-failed" && entry.errorCode === "ASK_ABORTED") {
      logger.debug(entry);
    } else {
      logger.warn(entry);
    }
  }

  async function inspectAndPrompt(agent: Agent): Promise<void> {
    if (closed || disposedAgents.has(agent)) return;
    let notice: RecoveryNotice | undefined;
    try {
      notice = classifyRecovery(ctx.goals.get(agent), latestTurnEnd(agent.session.events));
    } catch (error) {
      logger.warn({ event: "goal-recovery/inspection-failed", ...safeError(error) });
      return;
    }
    if (!notice) return;

    const key = recoveryNoticeKey(notice);
    const previous = pendingByAgent.get(agent);
    if (previous?.key === key) return;
    previous?.controller.abort();

    const controller = new AbortController();
    const pending = { key, controller };
    pendingByAgent.set(agent, pending);
    controllers.add(controller);

    try {
      let answer: unknown;
      try {
        answer = await ctx.userQuestions.ask(recoveryQuestion(notice, agent, controller.signal));
      } catch (error) {
        logFailure("goal-recovery/question-failed", notice, error);
        return;
      }

      if (controller.signal.aborted || !choseResume(answer) || notice.kind !== "resume-required") return;
      try {
        ctx.goals.resume(agent, notice.ref);
      } catch (error) {
        logFailure("goal-recovery/resume-failed", notice, error);
      }
    } finally {
      const current = pendingByAgent.get(agent);
      if (current?.key === key && current.controller === controller) {
        pendingByAgent.delete(agent);
      }
      controllers.delete(controller);
    }
  }

  ctx.on("agent/session-start", ({ agent }) => {
    queueMicrotask(() => { void inspectAndPrompt(agent); });
  });

  ctx.on("agent/disposed", ({ agent }) => {
    disposedAgents.add(agent);
    pendingByAgent.get(agent)?.controller.abort();
    pendingByAgent.delete(agent);
  });

  ctx.effect(() => () => {
    closed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  });
}

export default { name, inject, apply };
