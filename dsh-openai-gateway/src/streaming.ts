import type { ServerResponse } from "node:http";

import type { CompletionResult } from "./runner.ts";

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function chunk(result: CompletionResult, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: result.id,
    object: "chat.completion.chunk",
    created: result.created,
    model: result.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function sseFrames(result: CompletionResult, includeUsage: boolean): string[] {
  const frames = [data(chunk(result, { role: "assistant" }, null))];
  if (result.content !== null) {
    frames.push(data(chunk(result, { content: result.content }, null)));
  }
  for (const [index, call] of result.toolCalls.entries()) {
    frames.push(data(chunk(result, {
      tool_calls: [{
        index,
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }],
    }, null)));
  }
  frames.push(data(chunk(result, {}, result.finishReason)));
  if (includeUsage && result.usage) {
    const prompt = result.usage.inputTokens +
      (result.usage.cacheReadTokens ?? 0) +
      (result.usage.cacheWriteTokens ?? 0);
    frames.push(data({
      id: result.id,
      object: "chat.completion.chunk",
      created: result.created,
      model: result.model,
      choices: [],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: result.usage.outputTokens,
        total_tokens: prompt + result.usage.outputTokens,
      },
    }));
  }
  frames.push("data: [DONE]\n\n");
  return frames;
}

export function writeBufferedSse(
  res: ServerResponse,
  result: CompletionResult,
  includeUsage: boolean,
  requestId: string,
): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": requestId,
  });
  for (const frame of sseFrames(result, includeUsage)) {
    if (res.destroyed) return;
    res.write(frame);
  }
  res.end();
}
