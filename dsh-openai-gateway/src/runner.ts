import { randomUUID } from "node:crypto";

import { OpenAiError } from "./errors.ts";
import {
  appendHistory,
  buildConversation,
  toPromptMessage,
  type ChatCompletionRequest,
  type OpenAiToolCall,
} from "./messages.ts";
import type { GatewayConfig } from "./settings.ts";
import { installRequestTools } from "./tools.ts";

export interface CompletionResult {
  id: string;
  created: number;
  model: "auto-tier";
  content: string | null;
  toolCalls: OpenAiToolCall[];
  finishReason: "stop" | "tool_calls" | "length";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  routing: {
    initialTier?: string;
    finalTier?: string;
    escalations: number;
  };
}

interface RunnerDependencies {
  ctx: any;
  sessionId(id: string): unknown;
  installModelSelection(agentCtx: any, selection: any): () => void;
}

function routingMetadata(ctx: any, agentId: string): CompletionResult["routing"] {
  const state = ctx.modelRouter?.getState?.(agentId);
  if (!state) return { escalations: 0 };
  const finalTier = String(state.currentTierId);
  const escalations = Number(state.escalationCount) || 0;
  const tiers = ["fast", "medium", "smart"];
  const finalIndex = tiers.indexOf(finalTier);
  const initialIndex = finalIndex < 0 ? -1 : Math.max(0, finalIndex - escalations);
  return {
    ...(initialIndex < 0 ? {} : { initialTier: tiers[initialIndex] }),
    finalTier,
    escalations,
  };
}

function extractResult(ctx: any, agent: any, request: ChatCompletionRequest): CompletionResult {
  const events = Array.from(agent.session.events as readonly any[]);
  const turnEnd = events.findLast((event) => event.type === "turn/end");
  if (turnEnd?.data?.reason?.kind === "error") {
    const failure = turnEnd.data.reason.error;
    throw new OpenAiError(
      502,
      "api_error",
      String(failure?.code ?? "model_error").toLowerCase(),
      String(failure?.message ?? "Model request failed"),
    );
  }
  const assistant = events.findLast((event) => event.type === "assistant/message");
  if (!assistant) {
    throw new OpenAiError(502, "api_error", "empty_response", "DSH produced no assistant response");
  }
  const blocks = Array.isArray(assistant.data?.message?.content)
    ? assistant.data.message.content
    : [];
  const content = blocks
    .filter((block: any) => block?.type === "text")
    .map((block: any) => String(block.text ?? ""))
    .join("");
  const clientNames = new Set(request.tools.map((tool) => tool.name));
  const toolCalls: OpenAiToolCall[] = blocks
    .filter((block: any) => block?.type === "tool-call" && clientNames.has(String(block.name)))
    .map((block: any) => ({
      id: String(block.id),
      type: "function" as const,
      function: {
        name: String(block.name),
        arguments: String(block.arguments),
      },
    }));
  const length = turnEnd?.data?.reason?.kind === "max-tokens";
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: "auto-tier",
    content: content || null,
    toolCalls,
    finishReason: length ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop",
    ...(assistant.data?.usage ? { usage: assistant.data.usage } : {}),
    routing: routingMetadata(ctx, String(agent.id)),
  };
}

export function createCompletionRunner(deps: RunnerDependencies) {
  return async function runCompletion(
    request: ChatCompletionRequest,
    config: GatewayConfig,
    callerSignal: AbortSignal,
  ): Promise<CompletionResult> {
    const conversation = buildConversation(request.messages);
    const activity = new AbortController();
    let timedOut = false;
    let handle: any;

    const cancel = (reason: string) => {
      if (!activity.signal.aborted) activity.abort(reason);
      handle?.agent?.cancel?.({ kind: "hook", reason });
    };
    const onCallerAbort = () => cancel("openai-gateway-disconnect");
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      cancel("openai-gateway-timeout");
    }, config.requestTimeoutMs);
    timeout.unref?.();

    let bridge: ReturnType<typeof installRequestTools> | undefined;
    try {
      handle = await deps.ctx.agents.create({
        sessionId: deps.sessionId(`openai-gateway-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: {
          provider: "tiered-router",
          model: "auto-tier",
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        },
        signal: activity.signal,
        setup(agentCtx: any) {
          deps.installModelSelection(agentCtx, {
            current: { provider: "tiered-router", model: "auto-tier" },
            assembled: undefined,
          });
          if (conversation.system) {
            agentCtx.systemPrompt.section({
              name: "openai-gateway:request-system",
              order: -1_000,
              text: conversation.system,
              complete: true,
            });
          }
          if (request.temperature !== undefined || request.stop !== undefined) {
            agentCtx.on("agent/request", async (_payload: unknown, next: () => Promise<any>) => ({
              ...await next(),
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.stop === undefined ? {} : { stop: request.stop }),
            }));
          }
          bridge = installRequestTools(
            deps.ctx,
            agentCtx,
            request.tools,
            config.toolPolicy,
            request.toolChoice,
          );
        },
      });
      if (activity.signal.aborted) {
        handle.agent.cancel({ kind: "hook", reason: timedOut ? "openai-gateway-timeout" : "openai-gateway-disconnect" });
      }
      appendHistory(handle.agent.session, conversation.history);
      handle.agent.followup(toPromptMessage(conversation.prompt));
      await handle.agent.whenIdle();

      if (timedOut) {
        throw new OpenAiError(504, "timeout_error", "request_timeout", "The DSH request timed out");
      }
      if (callerSignal.aborted) {
        throw new OpenAiError(502, "api_error", "request_aborted", "The API client disconnected");
      }
      if (bridge?.error) throw bridge.error;
      return extractResult(deps.ctx, handle.agent, request);
    } catch (error) {
      if (timedOut && !(error instanceof OpenAiError && error.status === 504)) {
        throw new OpenAiError(504, "timeout_error", "request_timeout", "The DSH request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal.removeEventListener("abort", onCallerAbort);
      await handle?.dispose?.();
    }
  };
}
