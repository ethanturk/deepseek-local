/**
 * dsh-model-router
 * Tiered model routing + post-turn validation escalation for DeepSeek Harness.
 *
 * Design locked to user decisions (Aug 2026):
 * - 3 tiers: fast / medium / smart
 * - Classifier: heuristic + LLM ("both")
 * - Classify on every new user message
 * - Validate after a turn ends
 * - On validation fail → re-generate last assistant response on higher tier
 * - Stickiness configurable (default: current turn)
 * - Virtual model exposed in picker
 * - Subagents start one tier below parent
 * - Classifier/validator failure → put user in the loop
 * - Persist decisions to session event log
 * - Local guardrails follow per-tier boolean (default false)
 *
 * NOTE: Event names, ModelSelection APIs, and session event shapes are based on
 * the public architecture docs and community tier-router patterns. Adjust imports
 * and listener signatures against the exact packages installed in your checkout
 * (developer preview moves quickly).
 */

import type { Context } from "@deepseek-ai/cordis";
import {
  type Complexity,
  type ModelRouterConfig,
  type ModelRouterService,
  type RouterState,
  type TierId,
  DEFAULT_CONFIG,
} from "./types.js";
import { classifyHeuristic } from "./heuristic.js";

export const name = "dsh-model-router";
export const inject = ["llm", "systemPrompt", "tools", "sessions"];

/** Merge user config over defaults. */
function resolveConfig(raw?: Partial<ModelRouterConfig>): ModelRouterConfig {
  if (!raw) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    tiers: raw.tiers ?? DEFAULT_CONFIG.tiers,
    classifier: { ...DEFAULT_CONFIG.classifier, ...raw.classifier },
    validator: { ...DEFAULT_CONFIG.validator, ...raw.validator },
    virtualModel: { ...DEFAULT_CONFIG.virtualModel, ...raw.virtualModel },
  };
}

const TIER_ORDER: TierId[] = ["fast", "medium", "smart"];

function complexityToTier(c: Complexity): TierId {
  if (c === "simple") return "fast";
  if (c === "medium") return "medium";
  return "smart";
}

function nextHigherTier(current: TierId): TierId | null {
  const idx = TIER_ORDER.indexOf(current);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  return TIER_ORDER[idx + 1];
}

function oneTierBelow(current: TierId): TierId {
  const idx = TIER_ORDER.indexOf(current);
  if (idx <= 0) return "fast";
  return TIER_ORDER[idx - 1];
}

export function apply(ctx: Context, rawConfig?: Partial<ModelRouterConfig>) {
  const config = resolveConfig(rawConfig);
  const state = new Map<string, RouterState>();

  // ---------- helpers ----------

  function getOrCreateState(agentId: string): RouterState {
    let s = state.get(agentId);
    if (!s) {
      s = {
        currentTierId: "medium",
        escalationCount: 0,
        lastClassification: null,
        lastValidation: null,
        stickyUntil: null,
        pendingRegenerate: false,
      };
      state.set(agentId, s);
    }
    return s;
  }

  function tierConfig(tierId: TierId) {
    return config.tiers.find((t) => t.id === tierId);
  }

  /** Persist a routing / validation decision into the session log when possible. */
  function emitDecision(
    agentId: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    try {
      // Preferred: durable session event so it appears in Trajectory and survives resume.
      // Exact API varies; community plugins often use session/event or a custom extension.
      const sessions = (ctx as any).sessions;
      if (sessions?.appendEvent) {
        sessions.appendEvent({
          type: `model-router/${kind}`,
          agentId,
          ...payload,
          ts: Date.now(),
        });
      } else {
        console.log(`[dsh-model-router] ${kind}`, { agentId, ...payload });
      }
    } catch (err) {
      console.warn("[dsh-model-router] failed to persist decision", err);
    }
  }

  /** Put the user in the loop when classifier or validator itself fails. */
  function notifyUserInLoop(agentId: string, reason: string) {
    try {
      // Soft injection so the user sees the problem and can act.
      const agents = (ctx as any).agents;
      if (agents?.get?.(agentId)?.inject) {
        agents.get(agentId).inject({
          role: "system",
          content: `[Model Router] Automatic routing paused: ${reason}. Please choose a model manually or re-send your message.`,
        });
      } else {
        console.warn(`[dsh-model-router] USER IN LOOP (${agentId}): ${reason}`);
      }
      emitDecision(agentId, "user-in-loop", { reason });
    } catch (err) {
      console.warn("[dsh-model-router] notifyUserInLoop failed", err);
    }
  }

  /**
   * Write the chosen provider/model into the live selection seam.
   * Community tier routers typically write the session request header or
   * mutate ModelSelection so api-proxy / agent-loop pick it up.
   */
  /** Detect errors caused by unsupported / flaky reasoningEffort. */
  function isReasoningEffortError(err: unknown): boolean {
    const text = String(
      (err as any)?.message ??
        (err as any)?.code ??
        (err as any)?.reason ??
        err ??
        "",
    ).toLowerCase();
    return (
      /reasoning[_ ]?effort|reasoningeffort/.test(text) ||
      (/unsupported/.test(text) && /effort|reasoning|think/.test(text)) ||
      (err as any)?.code === "UNSUPPORTED"
    );
  }

  function applyModelSelection(agentId: string, tierId: TierId) {
    const tier = tierConfig(tierId);
    if (!tier) return;
    const s = getOrCreateState(agentId);

    try {
      // Pattern used by community plugins (dsh-tier-router etc.):
      // write into session request header / ModelSelectionRef.
      // ModelSelection in Harness includes optional reasoningEffort.
      const selection: {
        provider: string;
        model: string;
        reasoningEffort?: string;
      } = {
        provider: tier.provider,
        model: tier.model,
      };
      // Skip effort if we already learned it fails for this agent/session
      if (
        !s.reasoningEffortDisabled &&
        tier.reasoningEffort !== undefined
      ) {
        selection.reasoningEffort = tier.reasoningEffort;
      }

      // Attempt common seams; the first one that exists wins.
      const agent = (ctx as any).agents?.get?.(agentId);
      if (agent?.setModelSelection) {
        agent.setModelSelection(selection);
      } else if ((ctx as any).agentDefaultModel?.setSelection) {
        (ctx as any).agentDefaultModel.setSelection(selection);
      }

      // Also try rewriting live request options when present (agent/request path)
      const live = (ctx as any).__modelRouterLiveRequest;
      if (live && typeof live === "object") {
        live.provider = tier.provider;
        live.model = tier.model;
        if (
          !s.reasoningEffortDisabled &&
          tier.reasoningEffort !== undefined
        ) {
          live.reasoningEffort = tier.reasoningEffort;
        } else {
          delete live.reasoningEffort;
        }
      }

      emitDecision(agentId, "selection", {
        tierId,
        provider: tier.provider,
        model: tier.model,
        reasoningEffort: s.reasoningEffortDisabled
          ? null
          : (tier.reasoningEffort ?? null),
        reasoningEffortDisabled: Boolean(s.reasoningEffortDisabled),
      });
    } catch (err) {
      console.warn("[dsh-model-router] applyModelSelection failed", err);
      notifyUserInLoop(agentId, `Could not apply model selection: ${err}`);
    }
  }

  // ---------- LLM classifier (tiny prompt) ----------

  async function classifyWithLlm(message: string): Promise<Complexity | null> {
    const { provider, model } = config.classifier;
    if (!provider || !model) return null;

    try {
      const llm = (ctx as any).llm;
      if (!llm?.generate && !llm?.stream) {
        console.warn("[dsh-model-router] llm service unavailable for classifier");
        return null;
      }

      const prompt = `Classify the difficulty of the user request below.
Reply with exactly one word: simple, medium, or hard.

Request:
${message.slice(0, 2000)}`;

      // Prefer a non-streaming one-shot if available; otherwise collect stream.
      let text = "";
      if (typeof llm.generate === "function") {
        const res = await llm.generate({
          provider,
          model,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 8,
        });
        text = (res?.content ?? res?.text ?? "").toString().trim().toLowerCase();
      } else {
        // Fallback: stream and concatenate
        for await (const chunk of llm.stream({
          provider,
          model,
          messages: [{ role: "user", content: prompt }],
        })) {
          if (chunk?.text) text += chunk.text;
          if (chunk?.content) text += chunk.content;
        }
        text = text.trim().toLowerCase();
      }

      if (text.includes("hard")) return "hard";
      if (text.includes("medium")) return "medium";
      if (text.includes("simple")) return "simple";
      return null;
    } catch (err) {
      console.warn("[dsh-model-router] LLM classifier failed", err);
      return null;
    }
  }

  async function classifyMessage(
    message: string,
    context?: { hasFiles?: boolean; recentToolFailures?: number },
  ): Promise<Complexity> {
    const mode = config.classifier.mode;

    if (mode === "heuristic" || mode === "both") {
      const h = classifyHeuristic(message, context);
      if (mode === "heuristic") return h;
      // "both": use heuristic unless we want a second opinion on medium / ambiguous
      if (h !== "medium") return h;
    }

    if (mode === "llm" || mode === "both") {
      const llmResult = await classifyWithLlm(message);
      if (llmResult) return llmResult;
      if (mode === "both") {
        // LLM failed – fall back to heuristic result already computed, or recompute
        return classifyHeuristic(message, context);
      }
    }

    // Absolute fallback
    return "medium";
  }

  // ---------- Validator (smart tier judge) ----------

  async function validateTurn(
    userMessage: string,
    assistantResponse: string,
  ): Promise<{ passed: boolean; reason?: string }> {
    const smart = tierConfig(config.validator.alwaysUseTierId);
    if (!smart) {
      return { passed: true, reason: "no smart tier configured" };
    }

    try {
      const llm = (ctx as any).llm;
      if (!llm?.generate && !llm?.stream) {
        notifyUserInLoop("unknown", "Validator LLM unavailable");
        return { passed: true }; // fail-open to avoid blocking
      }

      const prompt = `You are a strict judge. Evaluate whether the assistant's response correctly and completely addresses the user request.
Reply in this exact format:
PASS
or
FAIL: <one-sentence reason>

User request:
${userMessage.slice(0, 1500)}

Assistant response:
${assistantResponse.slice(0, 3000)}`;

      let text = "";
      if (typeof llm.generate === "function") {
        const res = await llm.generate({
          provider: smart.provider,
          model: smart.model,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 60,
        });
        text = (res?.content ?? res?.text ?? "").toString().trim();
      } else {
        for await (const chunk of llm.stream({
          provider: smart.provider,
          model: smart.model,
          messages: [{ role: "user", content: prompt }],
        })) {
          if (chunk?.text) text += chunk.text;
          if (chunk?.content) text += chunk.content;
        }
        text = text.trim();
      }

      const upper = text.toUpperCase();
      if (upper.startsWith("PASS")) {
        return { passed: true };
      }
      if (upper.startsWith("FAIL")) {
        const reason = text.replace(/^FAIL\s*:?\s*/i, "").trim() || "unspecified";
        return { passed: false, reason };
      }
      // Ambiguous judge output – treat as pass but log
      console.warn("[dsh-model-router] ambiguous validator reply:", text);
      return { passed: true, reason: "ambiguous judge output" };
    } catch (err) {
      console.warn("[dsh-model-router] validator failed", err);
      notifyUserInLoop("unknown", `Validation failed: ${err}`);
      return { passed: true }; // fail-open
    }
  }

  // ---------- System prompt hint ----------

  if (config.enableSystemPromptHint) {
    try {
      (ctx as any).systemPrompt?.section?.({
        id: "model-router-hint",
        order: 40,
        content:
          "You are running under an automatic tiered model router. Focus on the current task. Be precise and concise.",
      });
    } catch {
      // optional
    }
  }

  // ---------- Virtual model registration ----------
  // Exact registration depends on the installed llm / catalog seams.
  // Community pattern: register a synthetic provider/model that the picker shows.
  try {
    const llm = (ctx as any).llm;
    if (llm?.registerVirtualModel) {
      llm.registerVirtualModel({
        id: config.virtualModel.id,
        displayName: config.virtualModel.displayName,
        description: "Automatic tiered routing (fast → medium → smart)",
      });
    } else {
      console.log(
        `[dsh-model-router] Virtual model "${config.virtualModel.displayName}" ` +
          `(id=${config.virtualModel.id}) – register via your catalog/settings if the seam is unavailable.`,
      );
    }
  } catch (err) {
    console.warn("[dsh-model-router] virtual model registration skipped", err);
  }

  // ---------- Event: new user message → classify ----------
  // Prefer the earliest point that sees a fresh user message.
  // Common seams: agent/pre-step (when claim contains new user content),
  // session/event for user/message, or inbox insertion.

  ctx.on("agent/pre-step" as any, async (claim: any, next: any) => {
    try {
      const agentId =
        claim?.agentId ?? claim?.agent?.id ?? claim?.id ?? "default";
      const s = getOrCreateState(agentId);

      // Detect new user message (simplified – adapt to real claim shape)
      const userText =
        claim?.messages?.find((m: any) => m.role === "user")?.content ??
        claim?.userMessage ??
        claim?.text;

      if (typeof userText === "string" && userText.trim()) {
        // Skip re-classification while sticky or while regenerating
        if (!s.stickyUntil && !s.pendingRegenerate) {
          const complexity = await classifyMessage(userText, {
            // Optional context can be filled from tools/session later
          });
          const tierId = complexityToTier(complexity);
          s.lastClassification = complexity;
          s.currentTierId = tierId;
          s.lastUserMessage = userText;
          s.escalationCount = 0;

          applyModelSelection(agentId, tierId);
          emitDecision(agentId, "classify", {
            complexity,
            tierId,
            messagePreview: userText.slice(0, 120),
          });
        }
      }
    } catch (err) {
      console.warn("[dsh-model-router] pre-step classify error", err);
      notifyUserInLoop("unknown", `Classification error: ${err}`);
    }
    return next?.() ?? undefined;
  });

  // ---------- Event: force selected model + reasoningEffort on request ----------
  ctx.on("agent/request" as any, async (request: any, next: any) => {
    try {
      const agentId =
        request?.agentId ?? request?.agent?.id ?? request?.id ?? "default";
      const s = getOrCreateState(agentId);
      const tierId = s.currentTierId;
      const tier = tierConfig(tierId);

      // Mutate request options in place when the payload exposes them
      if (request && typeof request === "object" && tier) {
        const useEffort =
          !s.reasoningEffortDisabled && tier.reasoningEffort !== undefined;

        if (request.options && typeof request.options === "object") {
          request.options.provider = tier.provider;
          request.options.model = tier.model;
          if (useEffort) {
            request.options.reasoningEffort = tier.reasoningEffort;
          } else if ("reasoningEffort" in request.options) {
            delete request.options.reasoningEffort;
          }
        }
        if (request.config && typeof request.config === "object") {
          request.config.provider = tier.provider;
          request.config.model = tier.model;
          if (useEffort) {
            request.config.reasoningEffort = tier.reasoningEffort;
          } else if ("reasoningEffort" in request.config) {
            delete request.config.reasoningEffort;
          }
        }
        // Direct fields on some builds
        if ("provider" in request) request.provider = tier.provider;
        if ("model" in request) request.model = tier.model;
        if (useEffort) {
          request.reasoningEffort = tier.reasoningEffort;
        } else if ("reasoningEffort" in request) {
          delete request.reasoningEffort;
        }
      }

      applyModelSelection(agentId, tierId);
    } catch (err) {
      console.warn("[dsh-model-router] agent/request error", err);
    }
    return next?.() ?? undefined;
  });

  // ---------- Detect flaky / unsupported reasoningEffort ----------
  // Harness surfaces provider failures on agent/request-error (and similar).
  const onRequestError = (payload: any) => {
    try {
      const agentId =
        payload?.agentId ??
        payload?.agent?.id ??
        payload?.request?.agentId ??
        "default";
      const err =
        payload?.error ?? payload?.err ?? payload?.reason ?? payload;

      if (!isReasoningEffortError(err)) return;

      const s = getOrCreateState(agentId);
      if (s.reasoningEffortDisabled) return; // already handled

      s.reasoningEffortDisabled = true;
      s.lastReasoningEffortError = String(
        (err as any)?.message ?? (err as any)?.code ?? err,
      );

      emitDecision(agentId, "reasoning-effort-fallback", {
        tierId: s.currentTierId,
        error: s.lastReasoningEffortError,
        action: "disable-effort-and-retry",
      });

      // Re-apply selection without effort
      applyModelSelection(agentId, s.currentTierId);

      // Soft notify — do not fully stop the user; auto-fallback is enough
      try {
        const agents = (ctx as any).agents;
        agents?.get?.(agentId)?.inject?.({
          role: "system",
          content:
            `[Model Router] reasoningEffort was rejected by the provider (${s.lastReasoningEffortError}). ` +
            `Retrying this tier without reasoning effort.`,
        });
      } catch {
        console.warn(
          `[dsh-model-router] reasoningEffort fallback (${agentId}):`,
          s.lastReasoningEffortError,
        );
      }

      // Best-effort: trigger a follow-up / retry if the agent API allows it
      try {
        const agent = (ctx as any).agents?.get?.(agentId);
        if (agent?.followup) {
          void agent.followup(undefined, {
            source: { kind: "model-router-effort-fallback" },
          });
        }
      } catch {
        // optional
      }
    } catch (e) {
      console.warn("[dsh-model-router] request-error handler failed", e);
    }
  };

  ctx.on("agent/request-error" as any, onRequestError);
  // Some builds use llm-level errors
  ctx.on("llm/error" as any, onRequestError);

  // ---------- Event: after turn ends → validate ----------
  ctx.on("turn/end" as any, async (turn: any) => {
    try {
      const agentId =
        turn?.agentId ?? turn?.agent?.id ?? turn?.id ?? "default";
      const s = getOrCreateState(agentId);

      // Clear turn-scoped stickiness
      if (s.stickyUntil === "end-of-turn") {
        s.stickyUntil = null;
      }

      const userMessage = s.lastUserMessage ?? turn?.userMessage ?? "";
      const assistantResponse =
        turn?.assistantMessage ??
        turn?.lastAssistant ??
        turn?.content ??
        "";

      if (!userMessage || !assistantResponse) {
        return;
      }

      const result = await validateTurn(userMessage, String(assistantResponse));
      s.lastValidation = result;
      emitDecision(agentId, "validate", {
        passed: result.passed,
        reason: result.reason,
        tierId: s.currentTierId,
      });

      if (!result.passed) {
        if (s.escalationCount >= config.validator.maxEscalations) {
          notifyUserInLoop(
            agentId,
            `Validation failed after ${s.escalationCount} escalations: ${result.reason}`,
          );
          return;
        }

        const higher = nextHigherTier(s.currentTierId);
        if (!higher) {
          notifyUserInLoop(
            agentId,
            `Already on smartest tier and validation failed: ${result.reason}`,
          );
          return;
        }

        // Escalate and request re-generation of the last assistant response
        s.escalationCount += 1;
        s.currentTierId = higher;
        s.pendingRegenerate = true;
        s.stickyUntil =
          config.validator.stickyScope === "session"
            ? "end-of-session"
            : "end-of-turn";

        applyModelSelection(agentId, higher);
        emitDecision(agentId, "escalate", {
          to: higher,
          reason: result.reason,
          escalationCount: s.escalationCount,
        });

        // Trigger re-generation (exact API depends on Agent handle)
        try {
          const agent = (ctx as any).agents?.get?.(agentId);
          if (agent?.regenerateLast || agent?.followup) {
            if (agent.regenerateLast) {
              await agent.regenerateLast();
            } else {
              await agent.followup(
                `Previous response failed validation (${result.reason}). Please provide an improved answer.`,
                { source: { kind: "model-router-escalate" } },
              );
            }
          } else {
            console.warn(
              "[dsh-model-router] no regenerate/followup API – escalation recorded only",
            );
          }
        } catch (err) {
          notifyUserInLoop(agentId, `Escalation trigger failed: ${err}`);
        }
      } else {
        s.pendingRegenerate = false;
      }
    } catch (err) {
      console.warn("[dsh-model-router] turn/end validation error", err);
      notifyUserInLoop("unknown", `Turn validation error: ${err}`);
    }
  });

  // ---------- Subagent: start one tier below parent ----------
  // Listen for subagent creation if the seam exists.
  ctx.on("agent/spawn" as any, (event: any) => {
    try {
      const parentId = event?.parentId ?? event?.parent?.id;
      const childId = event?.agentId ?? event?.agent?.id ?? event?.id;
      if (!parentId || !childId) return;

      const parentState = state.get(parentId);
      const parentTier = parentState?.currentTierId ?? "medium";
      const childTier = oneTierBelow(parentTier);

      const childState = getOrCreateState(childId);
      childState.currentTierId = childTier;
      applyModelSelection(childId, childTier);
      emitDecision(childId, "subagent-tier", {
        parentId,
        parentTier,
        childTier,
      });
    } catch (err) {
      console.warn("[dsh-model-router] subagent tier assignment failed", err);
    }
  });

  // ---------- Public service for local-model-guard & others ----------
  const service: ModelRouterService = {
    getCurrentTier(agentId: string) {
      return state.get(agentId)?.currentTierId;
    },
    getTierConfig(tierId: TierId) {
      return tierConfig(tierId);
    },
    isLocalGuardrailsEnabled(agentId: string) {
      const tierId = state.get(agentId)?.currentTierId;
      if (!tierId) return false;
      return tierConfig(tierId)?.enableLocalGuardrails ?? false;
    },
    forceTier(agentId: string, tierId: TierId) {
      const s = getOrCreateState(agentId);
      s.currentTierId = tierId;
      s.stickyUntil =
        config.validator.stickyScope === "session"
          ? "end-of-session"
          : "end-of-turn";
      applyModelSelection(agentId, tierId);
    },
    getState(agentId: string) {
      return state.get(agentId);
    },
  };

  // Provide under a well-known key if Cordis service API is available
  try {
    if (typeof (ctx as any).provide === "function") {
      (ctx as any).provide("modelRouter", service);
    } else if ((ctx as any).modelRouter === undefined) {
      (ctx as any).modelRouter = service;
    }
  } catch {
    (ctx as any).modelRouter = service;
  }

  console.log(
    `[dsh-model-router] loaded – virtual model "${config.virtualModel.displayName}", ` +
      `tiers: ${config.tiers.map((t) => t.id).join(" → ")}`,
  );
}

export default { name, inject, apply };
