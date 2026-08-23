/**
 * dsh-local-model-guard
 *
 * Strict monitoring for failed tool calls and repetitive loops, aimed at
 * flaky local / small models. Designed to work with dsh-model-router:
 *
 *   ctx.modelRouter.isLocalGuardrailsEnabled(agentId)
 *
 * When the router is present, guards only run for tiers that have
 * enableLocalGuardrails: true. When the router is absent, guards run
 * (unless forceAlways is used to override).
 *
 * Goals:
 * - Count consecutive tool failures
 * - Detect repeated tool+args signatures (loops)
 * - Intervene early via agent/pre-step (rewrite / soft stop)
 * - Optional light retries on tools/execute
 * - Keep added context tiny
 * - Persist interventions to session events when possible
 *
 * Developer-preview note: event shapes and tool result fields vary.
 * Listeners are defensive and log when seams are missing.
 */

import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import {
  type GuardState,
  type LocalGuardConfig,
  DEFAULT_GUARD_CONFIG,
} from "./types.ts";

export const name = "dsh-local-model-guard";
export const inject = [
  "tools",
  "modelRouter",
  "systemPrompt",
  "sessions",
];

function resolveConfig(raw?: Partial<LocalGuardConfig>): LocalGuardConfig {
  return { ...DEFAULT_GUARD_CONFIG, ...raw };
}

/** Stable-ish signature for loop detection (name + JSON args). */
function toolSignature(name: string, args: unknown): string {
  let argsKey = "";
  try {
    argsKey = JSON.stringify(args ?? null);
  } catch {
    argsKey = String(args);
  }
  // Keep signature short to limit memory
  if (argsKey.length > 200) argsKey = argsKey.slice(0, 200);
  return `${name}:${argsKey}`;
}

function hasRepeatedSignature(
  signatures: string[],
  maxRepeated: number,
): boolean {
  if (signatures.length < maxRepeated) return false;
  const last = signatures[signatures.length - 1];
  let count = 0;
  for (let i = signatures.length - 1; i >= 0; i--) {
    if (signatures[i] === last) count++;
    else break;
  }
  return count >= maxRepeated;
}

function isOpaqueSubagentFailure(
  exec: any,
  result: any,
): { agentId: string; reason: string; signal?: AbortSignal } | undefined {
  const toolName = String(exec?.name ?? exec?.toolName ?? exec?.tool?.name ?? "");
  if (toolName !== "subagent" || !Boolean(result?.isError ?? result?.error ?? result?.failed)) {
    return undefined;
  }
  const failure = result?.error ?? result?.message ?? result?.content;
  const message = String(failure?.message ?? failure ?? "").trim();
  if (!/^subagent run failed(?:\b|:)/i.test(message)) return undefined;
  return {
    agentId: exec?.agentId ?? result?.agentId ?? exec?.agent?.id ?? "default",
    reason: `SUBAGENT_RUN_FAILED: ${message}`,
    signal: exec?.signal ?? result?.signal,
  };
}

export function apply(ctx: Context, rawConfig?: Partial<LocalGuardConfig>) {
  const config = resolveConfig(rawConfig);
  const state = new Map<string, GuardState>();

  function getOrCreate(agentId: string): GuardState {
    let s = state.get(agentId);
    if (!s) {
      s = {
        consecutiveFailures: 0,
        recentSignatures: [],
        recentToolFailures: 0,
      };
      state.set(agentId, s);
    }
    return s;
  }

  /** Should we enforce guards for this agent right now? */
  function shouldEnforce(agentId: string): boolean {
    if (config.forceAlways) return true;

    const router = (ctx as any).modelRouter;
    if (router && typeof router.isLocalGuardrailsEnabled === "function") {
      try {
        return Boolean(router.isLocalGuardrailsEnabled(agentId));
      } catch {
        return false;
      }
    }

    // No router → apply by default (standalone use for local models)
    return true;
  }

  function emitGuardEvent(
    agentId: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    try {
      const sessions = (ctx as any).sessions;
      if (sessions?.appendEvent) {
        sessions.appendEvent({
          type: `local-guard/${kind}`,
          agentId,
          ...payload,
          ts: Date.now(),
        });
      } else {
        console.error(`[dsh-local-model-guard] ${kind}`, { agentId, ...payload });
      }
    } catch (err) {
      console.warn("[dsh-local-model-guard] emit failed", err);
    }
  }

  function createRecoveryMessage(reason: string) {
    return {
      id: randomUUID(),
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `${config.recoveryMessage}\n(Reason: ${reason})`,
        },
      ],
      source: { kind: "plugin" as const, plugin: name },
    };
  }

  // ---------- Tiny system-prompt section (keeps context small) ----------
  if (config.enableSystemPromptHint) {
    try {
      (ctx as any).systemPrompt?.section?.({
        name: "local-model-guard-hint",
        order: 45,
        text:
          "Local/small model mode: prefer short precise tool calls. " +
          "On tool failure, do not retry the same call with the same arguments — change the approach.",
      });
    } catch {
      // optional
    }
  }

  // ---------- Monitor tool results ----------
  const onToolOutcome = (payload: any) => {
    try {
      const agentId =
        payload?.agentId ??
        payload?.agent?.id ??
        payload?.exec?.agentId ??
        "default";

      if (!shouldEnforce(agentId)) return;

      const s = getOrCreate(agentId);
      const toolName =
        payload?.name ?? payload?.toolName ?? payload?.tool?.name ?? "unknown";
      const args = payload?.args ?? payload?.arguments ?? payload?.input;
      const isError = Boolean(
        payload?.isError ??
          payload?.error ??
          payload?.failed ??
          (payload?.kind === "error"),
      );

      const sig = toolSignature(String(toolName), args);
      s.recentSignatures = [
        ...s.recentSignatures.slice(-(config.windowSize - 1)),
        sig,
      ];

      if (isError) {
        s.consecutiveFailures += 1;
        s.recentToolFailures += 1;
        emitGuardEvent(agentId, "tool-failure", {
          toolName,
          consecutiveFailures: s.consecutiveFailures,
          signature: sig.slice(0, 80),
        });
      } else {
        s.consecutiveFailures = 0;
      }
    } catch (err) {
      console.warn("[dsh-local-model-guard] tool outcome handler error", err);
    }
  };

  // DSH passes (execution, result, next) through this authoritative waterfall.
  // Do not also consume tools/result: both fire for one call and double-count it.
  ctx.on("tools/post-execute" as any, async (exec: any, result: any, next: any) => {
    try {
      if (result && typeof result === "object") {
        const subagentFailure = isOpaqueSubagentFailure(exec, result);
        if (subagentFailure && shouldEnforce(subagentFailure.agentId)) {
          const tierId = (ctx as any).modelRouter?.escalateTier?.(
            subagentFailure.agentId,
            subagentFailure.reason,
            subagentFailure.signal,
          );
          if (tierId) {
            const guardState = getOrCreate(subagentFailure.agentId);
            guardState.pendingSubagentRetry =
              "A delegated subagent ended with an opaque runtime failure. Retry the delegated task exactly once on this higher tier. If it fails again, do not retry it; report the failure and continue with an alternative approach.";
            emitGuardEvent(subagentFailure.agentId, "subagent-failure-escalate", {
              tierId,
              reason: subagentFailure.reason,
            });
          }
        }
        onToolOutcome({
          ...exec,
          ...result,
          agentId: exec?.agentId ?? result?.agentId,
        });
      }
      return await next();
    } catch (err) {
      // Count thrown execution as failure
      onToolOutcome({
        ...exec,
        isError: true,
        error: err,
        agentId: exec?.agentId ?? "default",
      });
      throw err;
    }
  });

  // ---------- Optional light retries on tools/execute ----------
  if (config.enableRetries && config.maxRetries > 0) {
    ctx.on("tools/execute" as any, async (exec: any, next: any) => {
      const agentId = exec?.agentId ?? exec?.agent?.id ?? "default";
      if (!shouldEnforce(agentId)) {
        return next?.();
      }

      let lastErr: unknown;
      const attempts = 1 + config.maxRetries;
      for (let i = 0; i < attempts; i++) {
        try {
          return await next?.();
        } catch (err) {
          lastErr = err;
          const msg = String((err as any)?.message ?? err);
          // Only retry likely-transient failures
          const transient =
            /timeout|econnreset|socket|temporarily|rate limit|503|502/i.test(
              msg,
            );
          if (!transient || i === attempts - 1) throw err;
          // brief backoff
          await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        }
      }
      throw lastErr;
    });
  }

  // ---------- Recover model request failures ----------
  ctx.on("agent/request-error" as any, async (payload: any, next: any) => {
    let downstream: unknown;
    try {
      downstream = await next?.();
    } catch (err) {
      console.warn(
        "[dsh-local-model-guard] downstream request recovery failed; " +
          "preserving the original model failure",
        err,
      );
    }
    if ((downstream as any)?.kind === "retry") return downstream;

    const signal = payload?.signal;
    if (signal?.aborted) return downstream;
    const agentId =
      payload?.agentId ??
      payload?.agent?.id ??
      (ctx as any).agents?.currentAgent?.()?.id ??
      "default";
    if (!shouldEnforce(agentId)) return downstream;

    const failure = payload?.failure ?? payload?.error ?? payload?.reason;
    const code = String(failure?.code ?? "UNKNOWN");
    const message = String(failure?.message ?? failure ?? "model request failed");
    const reason = `${code}: ${message}`;
    const router = (ctx as any).modelRouter;
    const tierId = router?.escalateTier?.(agentId, reason, signal);
    if (!tierId) return downstream;

    emitGuardEvent(agentId, "model-failure-escalate", { code, tierId });
    return { kind: "retry" };
  });

  // ---------- Intervene before the model sees the next step ----------
  ctx.on("agent/pre-step" as any, async (claim: any, next: any) => {
    let recoveryReason: string | undefined;
    try {
      const agentId =
        claim?.agentId ?? claim?.agent?.id ?? claim?.id ?? "default";

      if (!shouldEnforce(agentId)) {
        return next?.();
      }

      const s = getOrCreate(agentId);
      if (s.pendingSubagentRetry) {
        recoveryReason = s.pendingSubagentRetry;
        s.pendingSubagentRetry = undefined;
        emitGuardEvent(agentId, "subagent-retry-injected", {});
      }
      const loop = hasRepeatedSignature(
        s.recentSignatures,
        config.maxRepeatedCalls,
      );
      const tooManyFailures =
        s.consecutiveFailures >= config.maxConsecutiveFailures;

      if (!recoveryReason && (loop || tooManyFailures)) {
        const reason = loop
          ? `repeated tool signature (≥${config.maxRepeatedCalls})`
          : `consecutive tool failures (≥${config.maxConsecutiveFailures})`;

        // Soft intervention: inject a tiny recovery message and reset counters
        // so we do not spam every subsequent step.
        const now = Date.now();
        // 6s cooldown avoids spamming recovery into context on every step
        if (!s.lastInterventionAt || now - s.lastInterventionAt > 6000) {
          recoveryReason = reason;
          emitGuardEvent(agentId, "intervention", { reason });
          s.lastInterventionAt = now;
          s.consecutiveFailures = 0;
          // Keep a short tail but break the immediate repeat streak
          s.recentSignatures = s.recentSignatures.slice(-1);
        }

        // Optionally rewrite claim messages if the API supports it
        if (claim?.messages && Array.isArray(claim.messages)) {
          // Leave structure intact; recovery is injected via agent.inject above
        }
      }
    } catch (err) {
      console.warn("[dsh-local-model-guard] pre-step error", err);
    }
    const decision = await next();
    if (!recoveryReason || decision.kind !== "enter") return decision;
    return {
      ...decision,
      messages: [...decision.messages, createRecoveryMessage(recoveryReason)],
    };
  });

  // ---------- Hard stop option on turn-stopping ----------
  ctx.on("agent/turn-stopping" as any, (turn: any) => {
    try {
      const agentId = turn?.agentId ?? turn?.agent?.id ?? "default";
      if (!shouldEnforce(agentId)) return;

      const s = getOrCreate(agentId);
      if (
        s.consecutiveFailures >= config.maxConsecutiveFailures * 2 ||
        hasRepeatedSignature(s.recentSignatures, config.maxRepeatedCalls + 1)
      ) {
        emitGuardEvent(agentId, "turn-stop-hint", {
          consecutiveFailures: s.consecutiveFailures,
        });
        // Serial event: we only log/hint; actual stop depends on loop consumers
      }
    } catch (err) {
      console.warn("[dsh-local-model-guard] turn-stopping error", err);
    }
  });

  // ---------- Reset failure streak on successful turn end ----------
  ctx.on("turn/end" as any, (turn: any) => {
    try {
      const agentId = turn?.agentId ?? turn?.agent?.id ?? "default";
      const s = state.get(agentId);
      if (!s) return;
      // Decay recent failure counter each turn
      s.recentToolFailures = Math.max(0, s.recentToolFailures - 1);
    } catch {
      // ignore
    }
  });

  console.error(
    `[dsh-local-model-guard] loaded – maxFailures=${config.maxConsecutiveFailures}, ` +
      `maxRepeated=${config.maxRepeatedCalls}, window=${config.windowSize}, ` +
      `retries=${config.enableRetries ? config.maxRetries : 0}, forceAlways=${config.forceAlways}`,
  );
}

export default { name, inject, apply };
