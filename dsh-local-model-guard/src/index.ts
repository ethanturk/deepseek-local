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
import {
  installSettingsSection,
  settingsNamespace,
} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import {
  type GuardState,
  type LocalGuardConfig,
  DEFAULT_GUARD_CONFIG,
} from "./types.ts";

export const name = "dsh-local-model-guard";
export const inject = [
  "compaction",
  "llm",
  "tokenMeter",
  "tools",
  "modelRouter",
  "systemPrompt",
  "sessions",
  "settings",
];

interface LocalGuardSettings {
  contextPressureThreshold: number;
  maxConcurrentSubagents: number;
}

export const LOCAL_MODEL_GUARD_SETTINGS_NAMESPACE = settingsNamespace(
  "local-model-guard",
);

export const LOCAL_MODEL_GUARD_SETTINGS_SCHEMA = z.object({
  contextPressureThreshold: z.number().required(),
  maxConcurrentSubagents: z.number().required(),
});

function validateContextPressureThreshold(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(
      "contextPressureThreshold must be greater than 0 and at most 1",
    );
  }
}

function validateMaxConcurrentSubagents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "maxConcurrentSubagents must be a positive safe integer",
    );
  }
}

function resolveConfig(raw?: Partial<LocalGuardConfig>): LocalGuardConfig {
  const config = { ...DEFAULT_GUARD_CONFIG, ...raw };
  validateContextPressureThreshold(config.contextPressureThreshold);
  validateMaxConcurrentSubagents(config.maxConcurrentSubagents);
  return config;
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
  const compositionConfig = resolveConfig(rawConfig);
  let config = compositionConfig;
  let settingsSource = (): LocalGuardSettings => ({
    contextPressureThreshold: compositionConfig.contextPressureThreshold,
    maxConcurrentSubagents: compositionConfig.maxConcurrentSubagents,
  });
  interface SubagentReservation { claimed: boolean }
  interface SubagentWaiter {
    resolve: (reservation: SubagentReservation) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }
  const subagentReservations: SubagentReservation[] = [];
  const activeSubagentRuns = new Set<string>();
  const subagentWaiters: SubagentWaiter[] = [];

  function removeWaiter(waiter: SubagentWaiter): void {
    const index = subagentWaiters.indexOf(waiter);
    if (index >= 0) subagentWaiters.splice(index, 1);
  }

  function drainSubagentQueue(): void {
    while (
      subagentWaiters.length > 0 &&
      activeSubagentRuns.size + subagentReservations.length <
        config.maxConcurrentSubagents
    ) {
      const waiter = subagentWaiters.shift()!;
      if (waiter.abort && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.abort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(Object.assign(new Error("Subagent launch cancelled"), {
          name: "AbortError",
        }));
        continue;
      }
      const reservation = { claimed: false };
      subagentReservations.push(reservation);
      waiter.resolve(reservation);
    }
  }

  function acquireSubagentSlot(
    signal?: AbortSignal,
  ): Promise<SubagentReservation> {
    if (signal?.aborted) {
      return Promise.reject(Object.assign(new Error("Subagent launch cancelled"), {
        name: "AbortError",
      }));
    }
    if (
      activeSubagentRuns.size + subagentReservations.length <
      config.maxConcurrentSubagents
    ) {
      const reservation = { claimed: false };
      subagentReservations.push(reservation);
      return Promise.resolve(reservation);
    }
    return new Promise((resolve, reject) => {
      const waiter: SubagentWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          removeWaiter(waiter);
          reject(Object.assign(new Error("Subagent launch cancelled"), {
            name: "AbortError",
          }));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      subagentWaiters.push(waiter);
    });
  }

  function releaseSubagentReservation(
    reservation: SubagentReservation,
  ): void {
    const index = subagentReservations.indexOf(reservation);
    if (index >= 0) subagentReservations.splice(index, 1);
    drainSubagentQueue();
  }

  if (typeof (ctx as any).inject === "function") {
    installSettingsSection(
      ctx,
      LOCAL_MODEL_GUARD_SETTINGS_NAMESPACE,
      LOCAL_MODEL_GUARD_SETTINGS_SCHEMA as z<LocalGuardSettings>,
      settingsSource(),
      {
        setSource(source) {
          settingsSource = source;
        },
        onChange() {
          config = resolveConfig({ ...compositionConfig, ...settingsSource() });
          drainSubagentQueue();
        },
        validate(value) {
          validateContextPressureThreshold(value.contextPressureThreshold);
          validateMaxConcurrentSubagents(value.maxConcurrentSubagents);
        },
      },
    );
  }
  const state = new Map<string, GuardState>();

  ctx.on("subagent/start" as any, (info: any) => {
    const runId = String(info?.runId ?? "");
    if (!runId || activeSubagentRuns.has(runId)) return;
    const reservation = subagentReservations.shift();
    if (reservation) reservation.claimed = true;
    activeSubagentRuns.add(runId);
  });

  ctx.on("subagent/end" as any, (info: any) => {
    const runId = String(info?.runId ?? "");
    if (!runId || !activeSubagentRuns.delete(runId)) return;
    drainSubagentQueue();
  });

  function getOrCreate(agentId: string): GuardState {
    let s = state.get(agentId);
    if (!s) {
      s = {
        consecutiveFailures: 0,
        recentSignatures: [],
        redundantBashEscalations: 0,
        askCallsThisStep: 0,
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

  function createGuardMessage(text: string) {
    return {
      id: randomUUID(),
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
      source: { kind: "plugin" as const, plugin: name },
    };
  }

  function createRecoveryMessage(reason: string) {
    return createGuardMessage(`${config.recoveryMessage}\n(Reason: ${reason})`);
  }

  async function compactForContextPressure(
    claim: any,
    agentId: string,
    guardState: GuardState,
  ): Promise<void> {
    if (guardState.contextPressureCompactionAttempted) return;
    const agent = claim?.agent;
    const router = (ctx as any).modelRouter;
    const tierId = router?.getCurrentTier?.(agentId);
    const tier = tierId && router?.getTierConfig?.(tierId);
    if (!agent?.session || !tier?.provider || !tier?.model) return;

    try {
      const signal = claim?.signal;
      const modelInfo = await (ctx as any).llm?.resolveModelInfo?.(
        tier.provider,
        tier.model,
        signal,
      );
      const contextWindow = Number(modelInfo?.context?.contextWindow);
      const totalTokens = Number(
        (ctx as any).tokenMeter?.measure?.(agent.session)?.totalTokens,
      );
      if (
        !Number.isFinite(contextWindow) ||
        contextWindow <= 0 ||
        !Number.isFinite(totalTokens) ||
        totalTokens < contextWindow * config.contextPressureThreshold
      ) {
        return;
      }

      guardState.contextPressureCompactionAttempted = true;
      emitGuardEvent(agentId, "context-pressure", {
        contextWindow,
        threshold: config.contextPressureThreshold,
        totalTokens,
      });
      try {
        const result = await (ctx as any).compaction?.compactIfNeeded?.(
          agent,
          "pressure",
          signal,
        );
        if (result) {
          emitGuardEvent(agentId, "context-pressure-compacted", {
            contextWindow,
            totalTokens,
          });
          return;
        }
        const reason =
          `CONTEXT_PRESSURE_COMPACTION_NOOP: ${totalTokens}/${contextWindow} tokens`;
        const escalatedTierId = router?.escalateTier?.(agentId, reason, signal);
        emitGuardEvent(agentId, "context-pressure-escalate", {
          reason,
          tierId: escalatedTierId,
        });
      } catch (error) {
        const message = String((error as any)?.message ?? error);
        const reason =
          `CONTEXT_PRESSURE_COMPACTION_FAILED: ${totalTokens}/${contextWindow} tokens: ${message}`;
        const escalatedTierId = router?.escalateTier?.(agentId, reason, signal);
        emitGuardEvent(agentId, "context-pressure-escalate", {
          reason,
          tierId: escalatedTierId,
        });
      }
    } catch (error) {
      console.warn("[dsh-local-model-guard] context pressure check failed", error);
    }
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
        const agentId =
          exec?.agentId ?? exec?.agent?.id ?? result?.agentId ?? "default";
        const toolName = String(
          exec?.name ?? exec?.toolName ?? exec?.tool?.name ?? "",
        );
        const failure = result?.error ?? result?.failure;
        const failureCode = String(failure?.code ?? result?.code ?? "");
        const redundantBashEscalation =
          toolName === "bash" &&
          Boolean(result?.isError ?? result?.error ?? result?.failed) &&
          /^sandbox escalation to .+ is not strictly wider than this call's current .+ mode$/i
            .test(String(failure?.message ?? result?.message ?? "").trim());

        if (toolName === "ask_user_question" && failureCode === "ASK_ABORTED") {
          return await next();
        }

        if (
          toolName === "ask_user_question" &&
          failureCode === "INVALID_ARGS" &&
          shouldEnforce(agentId)
        ) {
          const message = String(
            failure?.message ?? result?.message ?? "invalid ask arguments",
          );
          const reason = `ASK_USER_QUESTION_INVALID_ARGS: ${message}`;
          const tierId = (ctx as any).modelRouter?.escalateTier?.(
            agentId,
            reason,
            exec?.signal ?? result?.signal,
          );
          if (tierId) {
            getOrCreate(agentId).pendingAskRetry =
              "Ask the user once on this higher tier. Use one ask_user_question call with a valid questions array; do not send todo arguments or a second ask call.";
            emitGuardEvent(agentId, "ask-failure-escalate", { tierId, reason });
          }
        }

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

        const decision = await next();
        if (!redundantBashEscalation) return decision;

        const guardState = getOrCreate(agentId);
        guardState.redundantBashEscalations += 1;
        if (guardState.redundantBashEscalations === 1) {
          emitGuardEvent(agentId, "redundant-sandbox-escalation", {
            toolName,
          });
          return {
            ...decision,
            additionalContexts: [
              ...(decision?.additionalContexts ?? []),
              createGuardMessage(
                "The Bash command did not run because the requested sandbox escalation was redundant. Retry the exact command once without sandbox_permissions or justification.",
              ),
            ],
          };
        }

        exec?.agent?.cancel?.({
          kind: "hook",
          reason: "repeated-redundant-bash-sandbox-escalation",
        });
        emitGuardEvent(agentId, "sandbox-escalation-loop-cancelled", {
          toolName,
        });
        return decision;
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

  // ---------- Guard asks and optionally retry transient tool failures ----------
  ctx.on("tools/execute" as any, async (exec: any, next: any) => {
    const agentId = exec?.agentId ?? exec?.agent?.id ?? "default";
    const toolName = String(
      exec?.name ?? exec?.toolName ?? exec?.tool?.name ?? "",
    );
    const isSubagentTool =
      toolName === "subagent" || toolName === "subagent_fork";
    const reservation = isSubagentTool
      ? await acquireSubagentSlot(exec?.signal)
      : undefined;

    try {
      if (!shouldEnforce(agentId)) {
        return await next?.();
      }

      if (toolName === "ask_user_question") {
        const s = getOrCreate(agentId);
        if (s.askCallsThisStep >= 1) {
          const reason = "DUPLICATE_ASK_USER_QUESTION";
          const tierId = (ctx as any).modelRouter?.escalateTier?.(
            agentId,
            reason,
            exec?.signal,
          );
          if (tierId) {
            s.pendingAskRetry =
              "Ask the user once on this higher tier. Use one ask_user_question call with a valid questions array; do not send todo arguments or a second ask call.";
          }
          emitGuardEvent(agentId, "duplicate-ask-blocked", { tierId, reason });
          throw new Error(
            "Only one ask_user_question call is allowed per model step",
          );
        }
        s.askCallsThisStep += 1;
      }

      if (!config.enableRetries || config.maxRetries <= 0) {
        return await next?.();
      }

      let lastErr: unknown;
      const attempts = 1 + config.maxRetries;
      for (let i = 0; i < attempts; i++) {
        try {
          return await next?.();
        } catch (err) {
          lastErr = err;
          const msg = String((err as any)?.message ?? err);
          // Never retry an execution that already published a live child.
          const transient =
            !reservation?.claimed &&
            /timeout|econnreset|socket|temporarily|rate limit|503|502/i.test(
              msg,
            );
          if (!transient || i === attempts - 1) throw err;
          // brief backoff
          await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        }
      }
      throw lastErr;
    } finally {
      if (reservation && !reservation.claimed) {
        releaseSubagentReservation(reservation);
      }
    }
  });

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
    const guardState = getOrCreate(agentId);
    if (
      code === "CONTEXT_WINDOW_EXCEEDED" &&
      guardState.contextOverflowRecoveryAttempted
    ) {
      emitGuardEvent(agentId, "context-overflow-retry-exhausted", { code });
      return downstream;
    }
    const router = (ctx as any).modelRouter;
    const tierId = router?.escalateTier?.(agentId, reason, signal);
    if (!tierId) return downstream;

    if (code === "CONTEXT_WINDOW_EXCEEDED") {
      guardState.contextOverflowRecoveryAttempted = true;
    }
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
      s.askCallsThisStep = 0;
      await compactForContextPressure(claim, agentId, s);
      if (s.pendingAskRetry) {
        recoveryReason = s.pendingAskRetry;
        s.pendingAskRetry = undefined;
        emitGuardEvent(agentId, "ask-retry-injected", {});
      } else if (s.pendingSubagentRetry) {
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
    if (!recoveryReason || decision?.kind !== "enter") return decision;
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
      const messages = turn?.agent?.session?.deriveMessages?.();
      const lastAssistant = Array.isArray(messages)
        ? messages.findLast((message: any) => message?.role === "assistant")
        : undefined;
      const content = lastAssistant?.content;
      const hasVisibleText = typeof content === "string"
        ? Boolean(content.trim())
        : Array.isArray(content) && content.some((block: any) =>
          block?.type === "text" && String(block.text ?? "").trim()
        );
      const hasToolCall = Array.isArray(content) &&
        content.some((block: any) => block?.type === "tool-call");
      if (
        lastAssistant &&
        !hasVisibleText &&
        !hasToolCall &&
        !s.emptyResponseRecoveryAttempted &&
        typeof turn?.agent?.steer === "function"
      ) {
        const reason = "EMPTY_ASSISTANT_RESPONSE";
        const tierId = (ctx as any).modelRouter?.escalateTier?.(
          agentId,
          reason,
          turn?.signal,
        );
        if (tierId) {
          s.emptyResponseRecoveryAttempted = true;
          turn.agent.steer(createRecoveryMessage(
            "Previous response contained no visible answer. Provide a concise visible answer now without repeating completed tool work.",
          ));
          emitGuardEvent(agentId, "empty-response-escalate", { tierId });
        }
      }
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
      s.emptyResponseRecoveryAttempted = false;
      s.contextOverflowRecoveryAttempted = false;
      s.contextPressureCompactionAttempted = false;
      s.redundantBashEscalations = 0;
      // Decay recent failure counter each turn
      s.recentToolFailures = Math.max(0, s.recentToolFailures - 1);
    } catch {
      // ignore
    }
  });

  console.error(
    `[dsh-local-model-guard] loaded – maxFailures=${config.maxConsecutiveFailures}, ` +
      `maxRepeated=${config.maxRepeatedCalls}, window=${config.windowSize}, ` +
      `retries=${config.enableRetries ? config.maxRetries : 0}, ` +
      `contextPressure=${config.contextPressureThreshold}, ` +
      `maxSubagents=${config.maxConcurrentSubagents}, forceAlways=${config.forceAlways}`,
  );
}

export default { name, inject, apply };
