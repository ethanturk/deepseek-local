/**
 * dsh-llm-verifier
 *
 * LLM-as-a-Verifier post-turn scoring: the verifier backend is asked to
 * emit `<c1>LETTER</c1>` where the letter comes from a calibrated A..T
 * progress scale (A = 0% ... T = 100%). The score is the expectation over
 * the top-K token logprobs at the answer position, averaged over repeated
 * evaluations — a continuous reward in [0, 1] instead of a binary verdict.
 *
 * When dsh-model-router is loaded it calls ctx.llmVerifier.scoreTurn()
 * from its own validation path; this plugin then only provides the
 * service. Without the router it steers the agent once per user message
 * when the score is below the configured threshold.
 *
 * Port of https://github.com/llm-as-a-verifier/llm-as-a-verifier
 * (progress tracking variant).
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import {
  installSettingsSection,
  settingsNamespace,
} from "@deepseek-ai/dsh-settings";
import type { VerifierBackend } from "./client.ts";
import {
  buildStepsFromMessages,
  scoreTrajectory,
  DEFAULT_VERIFIER_CONFIG,
  type ScoreResult,
  type VerifierConfig,
} from "./verifier.ts";

export const name = "dsh-llm-verifier";
export const inject = ["sessions", "settings"];

export const LLM_VERIFIER_SETTINGS_NAMESPACE =
  settingsNamespace("llm-verifier");

export const LLM_VERIFIER_SETTINGS_SCHEMA = z.object({
  baseUrl: z.string().required(),
  apiKeyEnv: z.string().required(),
  model: z.string().required(),
  nEvaluations: z.number().required(),
  topLogprobs: z.number().required(),
  maxTokens: z.number().required(),
  timeoutMs: z.number().required(),
  threshold: z.number().required(),
  maxTrajectoryChars: z.number().required(),
  maxStepChars: z.number().required(),
  criteria: z
    .array(
      z.object({
        name: z.string().required(),
        description: z.string().required(),
      }),
    )
    .required(),
  steerOnLowScore: z.boolean().required(),
});

function validateConfig(config: VerifierConfig): void {
  if (!Number.isSafeInteger(config.nEvaluations) || config.nEvaluations < 1) {
    throw new TypeError("nEvaluations must be a positive integer");
  }
  if (
    !Number.isFinite(config.threshold) ||
    config.threshold < 0 ||
    config.threshold > 1
  ) {
    throw new TypeError("threshold must be in [0, 1]");
  }
  if (
    !Number.isSafeInteger(config.topLogprobs) ||
    config.topLogprobs < 1 ||
    config.topLogprobs > 20
  ) {
    throw new TypeError("topLogprobs must be an integer in [1, 20]");
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be greater than 0");
  }
}

function resolveConfig(raw?: Partial<VerifierConfig>): VerifierConfig {
  const config: VerifierConfig = {
    ...DEFAULT_VERIFIER_CONFIG,
    ...raw,
    criteria: raw?.criteria ?? DEFAULT_VERIFIER_CONFIG.criteria,
  };
  validateConfig(config);
  return config;
}

export interface LlmVerifierService {
  isConfigured(): boolean;
  scoreTurn(input: {
    agentId: string;
    problem: string;
    messages: any[];
    signal?: AbortSignal;
  }): Promise<{
    score: number;
    threshold: number;
    passed: boolean;
    perRep: Array<number | undefined>;
    steps: number;
  }>;
  scoreTrajectory(
    problem: string,
    steps: string[],
    signal?: AbortSignal,
  ): Promise<ScoreResult>;
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter(
      (block: any) => block?.type === "text" && typeof block.text === "string",
    )
    .map((block: any) => block.text)
    .join("\n");
}

function lastUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.role === "user" &&
      (!message?.source || message.source.kind === "user")
    ) {
      return i;
    }
  }
  return -1;
}

export function apply(ctx: Context, rawConfig?: Partial<VerifierConfig>) {
  const compositionConfig = resolveConfig(rawConfig);
  let config = compositionConfig;
  let settingsSource = () => compositionConfig;

  if (typeof (ctx as any).inject === "function") {
    installSettingsSection(
      ctx,
      LLM_VERIFIER_SETTINGS_NAMESPACE,
      LLM_VERIFIER_SETTINGS_SCHEMA as z<VerifierConfig>,
      compositionConfig,
      {
        setSource(source) {
          settingsSource = source;
        },
        onChange() {
          config = resolveConfig({ ...compositionConfig, ...settingsSource() });
        },
        validate(value) {
          validateConfig(value as VerifierConfig);
        },
      },
    );
  }

  let warnedNotConfigured = false;

  function isConfigured(): boolean {
    return typeof config.model === "string" && config.model.trim() !== "";
  }

  function resolveBackend(): VerifierBackend {
    if (!isConfigured()) {
      throw new Error("llm-verifier.model is not configured");
    }
    return {
      baseUrl: config.baseUrl,
      apiKey: process.env[config.apiKeyEnv],
      model: config.model,
      topLogprobs: config.topLogprobs,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs,
    };
  }

  function emitEvent(
    agentId: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    try {
      const sessions = (ctx as any).sessions;
      if (sessions?.appendEvent) {
        sessions.appendEvent({
          type: `llm-verifier/${kind}`,
          agentId,
          ...payload,
          ts: Date.now(),
        });
      } else {
        console.error(`[dsh-llm-verifier] ${kind}`, { agentId, ...payload });
      }
    } catch (err) {
      console.warn("[dsh-llm-verifier] emit failed", err);
    }
  }

  const service: LlmVerifierService = {
    isConfigured,

    async scoreTurn(input) {
      const backend = resolveBackend();
      const index = lastUserIndex(input.messages);
      const steps = index >= 0
        ? buildStepsFromMessages(input.messages, index, {
          maxStepChars: config.maxStepChars,
          maxTrajectoryChars: config.maxTrajectoryChars,
        })
        : [];
      if (steps.length === 0) {
        throw new Error("no assistant steps to score");
      }
      const result = await scoreTrajectory(backend, input.problem, steps, {
        nEvaluations: config.nEvaluations,
        criteria: config.criteria,
        signal: input.signal,
      });
      const passed = result.score >= config.threshold;
      emitEvent(input.agentId, "score", {
        score: result.score,
        threshold: config.threshold,
        passed,
        steps: steps.length,
        perRep: result.perRep,
      });
      return {
        score: result.score,
        threshold: config.threshold,
        passed,
        perRep: result.perRep,
        steps: steps.length,
      };
    },

    scoreTrajectory(problem, steps, signal) {
      return scoreTrajectory(resolveBackend(), problem, steps, {
        nEvaluations: config.nEvaluations,
        criteria: config.criteria,
        signal,
      });
    },
  };

  try {
    if (typeof (ctx as any).provide === "function") {
      (ctx as any).provide("llmVerifier", service);
    } else if ((ctx as any).llmVerifier === undefined) {
      (ctx as any).llmVerifier = service;
    }
  } catch {
    (ctx as any).llmVerifier = service;
  }

  // Track the last steered user-message index per agent so a low score
  // steers at most once per user message.
  const lastSteeredUserIndex = new Map<string, number>();

  ctx.on("agent/turn-stopping" as any, async (payload: any, next: any) => {
    try {
      // The router owns validation + escalation when it is loaded.
      if ((ctx as any).modelRouter) {
        return next?.() ?? undefined;
      }
      if (!isConfigured()) {
        if (!warnedNotConfigured) {
          warnedNotConfigured = true;
          console.warn(
            "[dsh-llm-verifier] llm-verifier.model is not configured; " +
              "standalone turn verification disabled",
          );
        }
        return next?.() ?? undefined;
      }
      const agent = payload?.agent;
      const agentId = agent?.id ?? "unknown";
      const messages = agent?.session?.deriveMessages?.();
      if (!Array.isArray(messages)) return next?.() ?? undefined;

      const index = lastUserIndex(messages);
      if (index < 0) return next?.() ?? undefined;
      if (lastSteeredUserIndex.get(agentId) === index) {
        return next?.() ?? undefined;
      }
      const problem = messageText(messages[index]);
      if (!problem.trim()) return next?.() ?? undefined;

      const result = await service.scoreTurn({
        agentId,
        problem,
        messages,
        signal: payload?.signal,
      });

      if (!result.passed && config.steerOnLowScore) {
        lastSteeredUserIndex.set(agentId, index);
        agent?.steer?.({
          role: "user",
          id: randomUUID(),
          content: [{
            type: "text",
            text:
              `[LLM Verifier] Verification score ${result.score.toFixed(2)} is below ${result.threshold}. ` +
              "The task does not appear to be completed and verified. " +
              "Re-check the observed outputs, fix what is missing, and " +
              "verify the result before finishing.",
          }],
          source: { kind: "plugin", id: name },
        });
      }
    } catch (err) {
      console.warn("[dsh-llm-verifier] turn-stopping error", err);
    }
    return next?.() ?? undefined;
  });

  console.error(
    `[dsh-llm-verifier] loaded – backend ${config.baseUrl}, ` +
      `model ${config.model || "(not configured)"}, ` +
      `threshold=${config.threshold}, nEvaluations=${config.nEvaluations}`,
  );
}

export default { name, inject, apply };
