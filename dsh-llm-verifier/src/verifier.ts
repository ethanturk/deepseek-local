/**
 * Trajectory → steps, and the K-repeated scoring loop.
 */

import { callVerifier, type VerifierBackend } from "./client.ts";
import { buildTurnPrompt, formatSteps, type VerifierCriterion } from "./prompts.ts";
import { extractTagScores } from "./scale.ts";

export interface VerifierConfig {
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  nEvaluations: number;
  topLogprobs: number;
  maxTokens: number;
  timeoutMs: number;
  threshold: number;
  maxTrajectoryChars: number;
  maxStepChars: number;
  criteria: VerifierCriterion[];
  steerOnLowScore: boolean;
}

export const DEFAULT_VERIFIER_CONFIG: VerifierConfig = {
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  model: "",
  nEvaluations: 2,
  topLogprobs: 20,
  maxTokens: 1024,
  timeoutMs: 60000,
  threshold: 0.5,
  maxTrajectoryChars: 24000,
  maxStepChars: 2000,
  criteria: [],
  steerOnLowScore: true,
};

export interface ScoreResult {
  score: number;
  perRep: Array<number | undefined>;
}

export interface ScoreTrajectoryOptions {
  nEvaluations: number;
  criteria?: VerifierCriterion[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Score the trajectory at a single checkpoint (the final step), repeated
 * `nEvaluations` times in parallel; the score is the mean over the repeats
 * that produced a readable value. Throws when no repeat produced a score.
 */
export async function scoreTrajectory(
  backend: VerifierBackend,
  problem: string,
  steps: string[],
  options: ScoreTrajectoryOptions,
): Promise<ScoreResult> {
  if (steps.length === 0) {
    throw new Error("need at least one step");
  }
  const k = options.nEvaluations;
  if (!Number.isInteger(k) || k < 1) {
    throw new Error("nEvaluations must be >= 1");
  }
  const prompt = buildTurnPrompt(
    problem,
    formatSteps(steps),
    steps.length,
    [steps.length],
    options.criteria,
  );
  const perRep = await Promise.all(
    Array.from({ length: k }, async () => {
      const { text, tokens, positionLogprobs } = await callVerifier(
        backend,
        prompt,
        { signal: options.signal, fetchImpl: options.fetchImpl },
      );
      return extractTagScores(text, tokens, positionLogprobs, 1)[0];
    }),
  );
  const defined = perRep.filter((v): v is number => v !== undefined);
  if (defined.length === 0) {
    throw new Error("verifier returned no readable score");
  }
  return {
    score: defined.reduce((a, b) => a + b, 0) / defined.length,
    perRep,
  };
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

function isRealUserMessage(message: any): boolean {
  return (
    message?.role === "user" &&
    (!message?.source || message.source.kind === "user")
  );
}

const TOOL_CALL_BLOCK_TYPES = new Set(["tool_call", "toolCall", "tool-call"]);

function toolCallBlocks(message: any): string[] {
  if (!Array.isArray(message?.content)) return [];
  const out: string[] = [];
  for (const block of message.content) {
    if (!TOOL_CALL_BLOCK_TYPES.has(block?.type)) continue;
    const name = String(
      block?.name ?? block?.toolName ?? block?.tool?.name ?? "unknown",
    );
    const args = block?.args ?? block?.arguments ?? block?.input;
    let argsText = "";
    try {
      argsText = JSON.stringify(args ?? null);
    } catch {
      argsText = String(args);
    }
    out.push(`[tool_call ${name}(${argsText})]`);
  }
  return out;
}

function isToolResultMessage(message: any): boolean {
  if (message?.role === "tool" || message?.role === "toolResult") return true;
  if (Array.isArray(message?.content)) {
    return message.content.some(
      (block: any) => block?.type === "tool_result" || block?.type === "toolResult",
    );
  }
  return false;
}

export interface BuildStepsOptions {
  maxStepChars: number;
  maxTrajectoryChars: number;
}

/**
 * One step per assistant message after the last real user message: text
 * blocks plus `[tool_call name(args)]` markers; tool-result messages append
 * `[tool_result] ...` to the previous step. Steps are truncated to
 * `maxStepChars`; the oldest steps are dropped (with a marker) until the
 * total fits `maxTrajectoryChars`.
 */
export function buildStepsFromMessages(
  messages: any[],
  lastUserIndex: number,
  options: BuildStepsOptions,
): string[] {
  const steps: string[] = [];
  for (let i = lastUserIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant") {
      const parts = [messageText(message).trim(), ...toolCallBlocks(message)]
        .filter(Boolean);
      steps.push(parts.join("\n"));
    } else if (isToolResultMessage(message)) {
      const text = messageText(message).trim();
      if (steps.length === 0) steps.push(`[tool_result] ${text}`);
      else steps[steps.length - 1] += `\n[tool_result] ${text}`;
    }
  }

  const truncated = steps.map((step) =>
    step.length > options.maxStepChars
      ? `${step.slice(0, options.maxStepChars)}\n[... step truncated ...]`
      : step,
  );

  const budget = options.maxTrajectoryChars;
  let total = truncated.reduce((sum, s) => sum + s.length, 0);
  let dropped = 0;
  while (truncated.length - dropped > 1 && total > budget) {
    total -= truncated[dropped].length;
    dropped++;
  }
  const kept = truncated.slice(dropped);
  if (dropped > 0) kept.unshift("[... earlier steps omitted ...]");
  return kept;
}
