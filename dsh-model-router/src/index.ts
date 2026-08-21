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
 * - Virtual model exposed in picker via LlmAdapter registration
 * - Subagents start one tier below parent
 * - Classifier/validator failure → put user in the loop
 * - Persist decisions to session event log
 * - Local guardrails follow per-tier boolean (default false)
 *
 * Harness API notes (v0.1.0-rc.7):
 * - agent/pre-step payload: { agent, messages, turn, step, signal }
 * - agent/request waterfall: (payload, next) => LlmCallConfig (return replacement)
 * - agent/request-error waterfall: (payload, next) => RequestErrorAction
 * - LlmAdapter is the registration mechanism for models to appear in the picker
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  installSettingsSection,
  settingsNamespace,
} from "@deepseek-ai/dsh-settings";
import {
  type Complexity,
  type ModelRouterConfig,
  type ModelRouterService,
  type RouterState,
  type TierId,
  DEFAULT_CONFIG,
} from "./types.ts";
import { classifyHeuristic } from "./heuristic.ts";

export const name = "dsh-model-router";
export const inject = ["llm", "systemPrompt", "tools", "sessions", "agents", "settings"];

export const MODEL_ROUTER_SETTINGS_NAMESPACE = settingsNamespace("model-router");

const tierSchema = z.object({
  id: z.union([z.const("fast"), z.const("medium"), z.const("smart")]).required(),
  provider: z.string().required(),
  model: z.string().required(),
  enableLocalGuardrails: z.boolean().required(),
  reasoningEffort: z.string(),
});

export const MODEL_ROUTER_SETTINGS_SCHEMA = z.object({
  tiers: z.array(tierSchema).required(),
  classifier: z.object({
    mode: z.union([z.const("heuristic"), z.const("llm"), z.const("both")]).required(),
    provider: z.string(),
    model: z.string(),
  }).required(),
  validator: z.object({
    alwaysUseTierId: z.union([z.const("fast"), z.const("medium"), z.const("smart")]).required(),
    maxEscalations: z.number().required(),
    stickyScope: z.union([z.const("turn"), z.const("session")]).required(),
  }).required(),
  virtualModel: z.object({
    id: z.string().required(),
    displayName: z.string().required(),
  }).required(),
  enableSystemPromptHint: z.boolean().required(),
});

type ModelRouterPluginConfig = Omit<Partial<ModelRouterConfig>, "tiers">;

/** Merge non-tier composition config over local-only defaults. */
function resolveConfig(raw?: ModelRouterPluginConfig): ModelRouterConfig {
  if (!raw) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    tiers: DEFAULT_CONFIG.tiers,
    classifier: { ...DEFAULT_CONFIG.classifier, ...raw.classifier },
    validator: { ...DEFAULT_CONFIG.validator, ...raw.validator },
    virtualModel: { ...DEFAULT_CONFIG.virtualModel, ...raw.virtualModel },
  };
}

function resolveSettings(raw?: Partial<ModelRouterConfig>): ModelRouterConfig {
  if (!raw) return resolveConfig();
  const { tiers, ...composition } = raw;
  return {
    ...resolveConfig(composition),
    tiers: tiers ?? DEFAULT_CONFIG.tiers,
  };
}

const TIER_ORDER: TierId[] = ["fast", "medium", "smart"];
const COMPLEXITY_ORDER: Complexity[] = ["simple", "medium", "hard"];

function higherComplexity(a: Complexity, b: Complexity): Complexity {
  return COMPLEXITY_ORDER.indexOf(a) >= COMPLEXITY_ORDER.indexOf(b) ? a : b;
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function recentConversation(messages: any[], latestUserIndex: number): string {
  const eligible = messages
    .slice(0, latestUserIndex + 1)
    .map((message, index) => ({ message, index, text: messageText(message).trim() }))
    .filter(({ message, text }) =>
      (message?.role === "assistant" ||
        (message?.role === "user" &&
          (!message?.source || message.source.kind === "user"))) &&
      text,
    );
  const selected = new Map(
    [...eligible.slice(-6), ...eligible.filter(({ message }) => message.role === "user").slice(-3)]
      .map((entry) => [entry.index, entry]),
  );
  return [...selected.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ message, text }) => `${message.role}: ${text.slice(0, 800)}`)
    .join("\n");
}

function createRegenerationMessage(reason: string) {
  return {
    role: "user",
    id: randomUUID(),
    content: [{
      type: "text",
      text: `[Model Router] Regenerate the answer for the original request on the higher tier. Address this validation failure: ${reason}`,
    }],
    source: { kind: "plugin", id: name },
  };
}

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

export function apply(ctx: Context, rawConfig?: ModelRouterPluginConfig) {
  const compositionConfig = resolveConfig(rawConfig);
  let config = compositionConfig;
  let settingsSource = () => compositionConfig;
  installSettingsSection(
    ctx,
    MODEL_ROUTER_SETTINGS_NAMESPACE,
    MODEL_ROUTER_SETTINGS_SCHEMA as z<ModelRouterConfig>,
    compositionConfig,
    {
      setSource(source) {
        settingsSource = source;
      },
      onChange() {
        config = resolveSettings(settingsSource());
      },
      validate(value) {
        const ids = value.tiers.map((tier) => tier.id);
        if (ids.join(",") !== "fast,medium,smart") {
          throw new Error("model-router tiers must be ordered fast, medium, smart");
        }
      },
    },
  );
  const state = new Map<string, RouterState>();
  const tierBySignal = new WeakMap<object, TierId>();
  const llm = (ctx as any).llm;
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
        reasoningEffortDisabled: false,
        lastReasoningEffortError: null,
        lastUserMessage: null,
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
      const agents = (ctx as any).agents;
      const agent = agents?.get?.(agentId);
      if (agent?.inject) {
        agent.inject({
          role: "user",
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

  async function generateText(
    provider: string,
    model: string,
    prompt: string,
    maxTokens: number,
  ): Promise<string> {
    if (typeof llm?.stream !== "function") {
      throw new Error("LLM stream service unavailable");
    }

    let text = "";
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: [{
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: prompt }],
        source: { kind: "plugin", plugin: name },
      }],
      maxTokens,
    })) {
      if (chunk?.type === "text-delta") text += chunk.text;
      if (
        chunk?.type === "finish" &&
        (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")
      ) {
        throw new Error(`LLM stream finished with ${chunk.reason.kind}`);
      }
    }
    return text.trim();
  }

  // ---------- LLM classifier (tiny prompt) ----------

  async function classifyWithLlm(
    message: string,
    conversation: string,
  ): Promise<Complexity | null> {
    const { provider, model } = config.classifier;
    if (!provider || !model) return null;

    try {
      const prompt = `Classify the difficulty of the current user request using the recent conversation for context.
Reply with exactly one word: simple, medium, or hard.

Recent conversation:
${conversation.slice(-3000)}

Current request:
${message.slice(0, 2000)}`;

      const text = (await generateText(provider, model, prompt, 8)).toLowerCase();

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
    conversation = message,
  ): Promise<Complexity> {
    const mode = config.classifier.mode;
    const heuristic = classifyHeuristic(message, context);

    if (mode === "heuristic") return heuristic;

    if (mode === "llm" || mode === "both") {
      const llmResult = await classifyWithLlm(message, conversation);
      if (llmResult && mode === "both") {
        return higherComplexity(heuristic, llmResult);
      }
      if (llmResult) return llmResult;
      if (mode === "both") return heuristic;
    }

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
      const prompt = `You are a strict judge. Evaluate whether the assistant's response correctly and completely addresses the user request.
Reply in this exact format:
PASS
or
FAIL: <one-sentence reason>

User request:
${userMessage.slice(0, 1500)}

Assistant response:
${assistantResponse.slice(0, 3000)}`;

      const text = await generateText(smart.provider, smart.model, prompt, 60);

      const upper = text.toUpperCase();
      if (upper.startsWith("PASS")) {
        return { passed: true };
      }
      if (upper.startsWith("FAIL")) {
        const reason = text.replace(/^FAIL\s*:?\s*/i, "").trim() || "unspecified";
        return { passed: false, reason };
      }
      console.warn("[dsh-model-router] ambiguous validator reply:", text);
      return { passed: true, reason: "ambiguous judge output" };
    } catch (err) {
      console.warn("[dsh-model-router] validator failed", err);
      notifyUserInLoop("unknown", `Validation failed: ${err}`);
      return { passed: true };
    }
  }

  // ---------- System prompt hint ----------

  if (config.enableSystemPromptHint) {
    try {
      (ctx as any).systemPrompt?.section?.({
        name: "model-router-hint",
        order: 40,
        text:
          "You are running under an automatic tiered model router. Focus on the current task. Be precise and concise.",
      });
    } catch {
      // optional
    }
  }

  // ========================================================
  // VIRTUAL MODEL — register via LlmAdapter so it appears in the picker
  // ========================================================

  /**
   * Minimal LlmAdapter that represents the virtual "Auto (Tiered Router)" model.
   * Registered under the unique provider name config.virtualModel.id
   * so it appears in its own group in the model picker.
   */
  const VIRTUAL_PROVIDER = config.virtualModel.id; // "auto-tier"

  class TieredRouterAdapter {
    /** LlmAdapter.providerInfo — metadata for the virtual provider route */
    providerInfo(provider: string) {
      console.log(`[dsh-model-router] adapter.providerInfo("${provider}")`);
      return {
        id: provider,
        name: provider,
        displayName: config.virtualModel.displayName,
      };
    }

    /** LlmAdapter.providerRetryPolicy — retry policy for the provider */
    providerRetryPolicy(_provider: string) {
      console.log(`[dsh-model-router] adapter.providerRetryPolicy("${_provider}")`);
      return { maxRetries: 3, retryDelay: 1000 };
    }

    /** LlmAdapter.listModels — return the virtual model for this provider */
    listModels(provider: string) {
      console.log(`[dsh-model-router] adapter.listModels("${provider}")`);
      return Promise.resolve([
        {
          provider,
          id: config.virtualModel.id,
          name: config.virtualModel.displayName,
          description: "Automatic tiered routing (fast → medium → smart)",
        },
      ]);
    }

    /** LlmAdapter.resolveModel — exact model metadata for the catalog */
    async resolveModel(provider: string, model: string, signal?: AbortSignal) {
      // Always return a valid object — Harness validates resolved.name.length etc.
      // For pass-through unknown models, echo the requested model info
      if (model !== config.virtualModel.id) {
        return {
          provider,
          id: model,
          name: model,
        };
      }

      const activeAgentId = (ctx as any).agents?.currentAgent?.()?.id;
      const tierId =
        (signal && tierBySignal.get(signal)) ??
        (activeAgentId ? state.get(activeAgentId)?.currentTierId : undefined) ??
        "medium";
      const tier = tierConfig(tierId);
      const physical = tier && typeof llm?.resolveModelInfo === "function"
        ? await llm.resolveModelInfo(tier.provider, tier.model, signal)
        : {};

      return {
        ...physical,
        provider,
        id: model,
        name: config.virtualModel.displayName,
        description: "Automatic tiered routing (fast → medium → smart)",
      };
    }

    /** LlmAdapter.stream — delegate to the real provider after resolving the tier */
    async *stream(options: Record<string, any>): AsyncIterable<unknown> {
      try {
        // Resolve the tier for the current agent
        const activeAgentId = (ctx as any).agents?.currentAgent?.()?.id;
        const tierId =
          (options.signal && tierBySignal.get(options.signal)) ??
          (activeAgentId ? state.get(activeAgentId)?.currentTierId : undefined) ??
          "medium";
        console.log(`[dsh-model-router] resolved tierId="${tierId}" (activeAgentId="${activeAgentId}")`);
        const tier = tierConfig(tierId);
        if (!tier) {
          throw new Error(`No tier configured for current routing state`);
        }
        console.log(`[dsh-model-router] routing to tier: ${tier.provider}/${tier.model}`);

        const callConfig = {
          ...options,
          provider: tier.provider,
          model: tier.model,
          reasoningEffort: options.reasoningEffort ?? tier.reasoningEffort,
        };

        for await (const chunk of llm.stream(callConfig)) {
          yield chunk;
        }
      } catch (err) {
        console.error(`[dsh-model-router] stream() error:`, err);
        throw err;
      }
    }
  }

  // Register under a unique provider name so it doesn't conflict with built-in adapters
  const adapter = new TieredRouterAdapter();
  try {
    llm.registerAdapter([VIRTUAL_PROVIDER], adapter);
    console.log(
      `[dsh-model-router] registered virtual adapter for provider "${VIRTUAL_PROVIDER}" ` +
        `with model "${config.virtualModel.displayName}"`,
    );
  } catch (err) {
    console.warn(
      `[dsh-model-router] virtual adapter registration failed for "${VIRTUAL_PROVIDER}":`,
      err,
    );
  }

  // ========================================================
  // EVENT HANDLERS — Harness v0.1.0-rc.7 API
  // ========================================================

  // ---------- Event: new user message → classify (pre-step) ----------
  ctx.on("agent/pre-step" as any, async (payload: any, next: any) => {
    console.log(`[dsh-debug] agent/pre-step: agentId=${(payload?.agent?.id ?? "unknown")} msgCount=${(payload?.messages as any[] | undefined)?.length ?? 0}`);
    try {
      const agent = payload?.agent;
      const agentId = agent?.id ?? "unknown";
      const s = getOrCreateState(agentId);
      if (payload?.signal && typeof payload.signal === "object") {
        tierBySignal.set(payload.signal, s.currentTierId);
      }

      // Only classify on new user messages, not on every step
      const messages = payload?.messages as any[] | undefined;
      if (!Array.isArray(messages) || messages.length === 0) {
        console.log(`[dsh-debug] agent/pre-step: skipping (no messages)`);
        return next?.() ?? undefined;
      }

      // Find the latest user message
      let userText = "";
      let latestUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          userText = messageText(messages[i]);
          latestUserIndex = i;
          break;
        }
      }

      if (typeof userText === "string" && userText.trim()) {
        // Skip re-classification while sticky or while regenerating
        if (
          !s.stickyUntil &&
          !s.pendingRegenerate &&
          userText !== s.lastUserMessage
        ) {
          let conversationMessages = messages;
          let conversationUserIndex = latestUserIndex;
          const sessionMessages = agent?.session?.deriveMessages?.();
          if (Array.isArray(sessionMessages) && sessionMessages.length > 0) {
            conversationMessages = sessionMessages;
            conversationUserIndex = -1;
            for (let i = sessionMessages.length - 1; i >= 0; i--) {
              if (
                sessionMessages[i]?.role === "user" &&
                messageText(sessionMessages[i]) === userText
              ) {
                conversationUserIndex = i;
                break;
              }
            }
            if (conversationUserIndex < 0) {
              conversationMessages = [...sessionMessages, messages[latestUserIndex]];
              conversationUserIndex = conversationMessages.length - 1;
            }
          }
          const conversation = recentConversation(
            conversationMessages,
            conversationUserIndex,
          );
          const complexity = await classifyMessage(userText, {
            recentToolFailures: s.recentToolFailures ?? 0,
            hasFiles: /\b[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|java|cpp|h|css|json|yaml|yml|md)\b/i.test(conversation),
          }, conversation);
          const tierId = complexityToTier(complexity);
          s.lastClassification = complexity;
          s.currentTierId = tierId;
          s.lastUserMessage = userText;
          s.escalationCount = 0;

          emitDecision(agentId, "classify", {
            complexity,
            tierId,
            messagePreview: userText.slice(0, 120),
          });
        }
      }
      if (payload?.signal && typeof payload.signal === "object") {
        tierBySignal.set(payload.signal, s.currentTierId);
      }
    } catch (err) {
      console.warn("[dsh-model-router] pre-step classify error", err);
    }
    return next?.() ?? undefined;
  });

  // ---------- Event: select model on each request (request waterfall) ----------
  ctx.on("agent/request" as any, async (payload: any, next: any) => {
    try {
      const agent = payload?.agent;
      const agentId = agent?.id ?? "unknown";
      const s = getOrCreateState(agentId);
      const tierId = s.currentTierId;
      const tier = tierConfig(tierId);
      if (payload?.signal && typeof payload.signal === "object") {
        tierBySignal.set(payload.signal, tierId);
      }
      console.log(`[dsh-debug] agent/request: agentId=${agentId} tierId=${tierId}`);

      if (!tier) {
        console.log(`[dsh-debug] agent/request: no tier, passing through`);
        return next?.() ?? undefined;
      }

      // Get the default config from the waterfall
      const defaultConfig = await next?.();
      console.log(`[dsh-debug] agent/request: defaultConfig.provider=${defaultConfig?.provider} defaultConfig.model=${defaultConfig?.model} returning=${tier.provider}/${tier.model}`);

      const usesVirtualRoute =
        defaultConfig?.provider === VIRTUAL_PROVIDER &&
        defaultConfig?.model === config.virtualModel.id;
      const selection: Record<string, unknown> = usesVirtualRoute
        ? { ...defaultConfig }
        : { provider: tier.provider, model: tier.model };

      // Add reasoningEffort if not disabled
      if (!s.reasoningEffortDisabled && tier.reasoningEffort !== undefined) {
        selection.reasoningEffort = tier.reasoningEffort;
      } else if (defaultConfig?.reasoningEffort !== undefined) {
        selection.reasoningEffort = undefined as any;
      }

      // Copy over any other fields from the default config
      for (const key of ["temperature", "maxTokens", "stop"]) {
        if (key in (defaultConfig || {})) {
          (selection as any)[key] = (defaultConfig as any)[key];
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

      s.pendingRegenerate = false;

      return selection;
    } catch (err) {
      console.warn("[dsh-model-router] agent/request error", err);
      return next?.() ?? undefined;
    }
  });

  // ---------- Detect flaky / unsupported reasoningEffort ----------
  const onRequestError = async (payload: any, next: any) => {
    try {
      const agent = payload?.agent;
      const agentId = agent?.id ?? "unknown";
      const err = payload?.failure ?? payload?.error ?? payload?.reason ?? payload;

      if (!isReasoningEffortError(err)) return await next?.();

      const s = getOrCreateState(agentId);
      if (s.reasoningEffortDisabled) return await next?.();

      s.reasoningEffortDisabled = true;
      s.lastReasoningEffortError = String(
        (err as any)?.message ?? (err as any)?.code ?? err,
      );

      emitDecision(agentId, "reasoning-effort-fallback", {
        tierId: s.currentTierId,
        error: s.lastReasoningEffortError,
        action: "disable-effort-and-retry",
      });

      try {
        agent?.inject?.({
          role: "user",
          content:
            `[Model Router] reasoningEffort was rejected by the provider (${s.lastReasoningEffortError}). ` +
            `This tier will retry without reasoning effort.`,
        });
      } catch {
        console.warn(
          `[dsh-model-router] reasoningEffort fallback (${agentId}):`,
          s.lastReasoningEffortError,
        );
      }

      return await next?.();
    } catch (e) {
      console.warn("[dsh-model-router] request-error handler failed", e);
      return await next?.();
    }
  };

  ctx.on("agent/request-error" as any, onRequestError);

  // ---------- Event: after turn ends ----------
  ctx.on("agent/turn-stopping" as any, async (payload: any, next: any) => {
    try {
      const agent = payload?.agent;
      const agentId = agent?.id ?? "unknown";
      const s = getOrCreateState(agentId);

      // Clear turn-scoped stickiness
      if (s.stickyUntil === "end-of-turn") {
        s.stickyUntil = null;
      }

      // Decay recent failure counter
      if (s.recentToolFailures !== undefined) {
        s.recentToolFailures = Math.max(0, (s.recentToolFailures || 0) - 1);
      }

      const messages = payload?.agent?.session?.deriveMessages?.();
      if (!Array.isArray(messages) || !s.lastUserMessage) {
        return next?.() ?? undefined;
      }

      let assistantResponse = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") {
          assistantResponse = messageText(messages[i]);
          break;
        }
      }
      if (!assistantResponse.trim()) return next?.() ?? undefined;

      const validation = await validateTurn(
        s.lastUserMessage,
        assistantResponse,
      );
      s.lastValidation = validation;
      emitDecision(agentId, "validate", {
        tierId: s.currentTierId,
        ...validation,
      });

      if (!validation.passed) {
        const nextTier = nextHigherTier(s.currentTierId);
        if (nextTier && s.escalationCount < config.validator.maxEscalations) {
          s.currentTierId = nextTier;
          s.escalationCount += 1;
          s.pendingRegenerate = true;
          payload.agent.steer(createRegenerationMessage(
            validation.reason ?? "unspecified validation failure",
          ));
          emitDecision(agentId, "escalate", {
            tierId: nextTier,
            escalationCount: s.escalationCount,
            reason: validation.reason ?? "unspecified validation failure",
          });
        }
      }
    } catch (err) {
      console.warn("[dsh-model-router] turn-stopping error", err);
    }
    return next?.() ?? undefined;
  });

  // ---------- Subagent: start one tier below parent ----------
  ctx.on("agent/created" as any, (payload: any) => {
    try {
      const agent = payload?.agent;
      const childId = agent?.id;
      if (!childId) return;

      const parentAgent = (ctx as any).agents?.currentInitiator?.();
      const parentId = parentAgent?.id;
      if (!parentId) return;

      const parentState = state.get(parentId);
      const parentTier = parentState?.currentTierId ?? "medium";
      const childTier = oneTierBelow(parentTier);

      const childState = getOrCreateState(childId);
      childState.currentTierId = childTier;
      emitDecision(childId, "subagent-tier", {
        parentId,
        parentTier,
        childTier,
      });
    } catch (err) {
      console.warn("[dsh-model-router] subagent tier assignment failed", err);
    }
  });

  // ---------- Expose service for local-model-guard & others ----------
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
    escalateTier(agentId: string, reason: string, signal?: AbortSignal) {
      const s = getOrCreateState(agentId);
      const nextTier = nextHigherTier(s.currentTierId);
      if (!nextTier || s.escalationCount >= config.validator.maxEscalations) {
        return null;
      }
      s.currentTierId = nextTier;
      s.escalationCount += 1;
      s.stickyUntil =
        config.validator.stickyScope === "session"
          ? "end-of-session"
          : "end-of-turn";
      if (signal) tierBySignal.set(signal, nextTier);
      emitDecision(agentId, "request-failure-escalate", {
        tierId: nextTier,
        escalationCount: s.escalationCount,
        reason,
      });
      return nextTier;
    },
    forceTier(agentId: string, tierId: TierId) {
      const s = getOrCreateState(agentId);
      s.currentTierId = tierId;
      s.stickyUntil =
        config.validator.stickyScope === "session"
          ? "end-of-session"
          : "end-of-turn";
    },
    getState(agentId: string) {
      return state.get(agentId);
    },
  };

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
