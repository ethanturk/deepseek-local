import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { OpenAiError } from "./errors.ts";
import { parseChatCompletionRequest, type ChatCompletionRequest } from "./messages.ts";
import type { CompletionResult } from "./runner.ts";
import { authenticateBearer, type GatewayConfig } from "./settings.ts";
import { writeBufferedSse } from "./streaming.ts";

interface RouteDependencies {
  getConfig(): GatewayConfig;
  getApiKeys(): readonly string[];
  run(request: ChatCompletionRequest, config: GatewayConfig, signal: AbortSignal): Promise<CompletionResult>;
  log(entry: Record<string, unknown>): void;
}

export function errorBody(error: OpenAiError) {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  };
}

function usageBody(usage: CompletionResult["usage"]) {
  if (!usage) return undefined;
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
  };
}

export function completionBody(result: CompletionResult) {
  return {
    id: result.id,
    object: "chat.completion",
    created: result.created,
    model: result.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: result.content,
        ...(result.toolCalls.length === 0 ? {} : { tool_calls: result.toolCalls }),
      },
      finish_reason: result.finishReason,
    }],
    ...(result.usage ? { usage: usageBody(result.usage) } : {}),
  };
}

function cors(req: IncomingMessage, res: ServerResponse, config: GatewayConfig): void {
  const origin = req.headers.origin;
  if (!origin || !config.corsOrigins.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (res.destroyed || res.writableEnded) return;
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "x-request-id": requestId,
  });
  res.end(encoded);
}

function asOpenAiError(error: unknown): OpenAiError {
  if (error instanceof OpenAiError) return error;
  return new OpenAiError(
    502,
    "api_error",
    "provider_error",
    error instanceof Error ? error.message : "DSH request failed",
  );
}

function authenticate(req: IncomingMessage, deps: RouteDependencies): void {
  if (!authenticateBearer(req.headers.authorization, deps.getApiKeys())) {
    throw new OpenAiError(401, "authentication_error", "invalid_api_key", "Invalid or missing API key");
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new OpenAiError(400, "invalid_request_error", "invalid_content_type", "Content-Type must be application/json", "content-type");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new OpenAiError(400, "invalid_request_error", "request_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OpenAiError(400, "invalid_request_error", "invalid_json", "Request body must contain valid JSON");
  }
}

export function createGatewayRoutes(deps: RouteDependencies) {
  let activeRequests = 0;

  function acquire(limit: number): (() => void) | undefined {
    if (activeRequests >= limit) return undefined;
    activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRequests -= 1;
    };
  }

  async function models(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const config = deps.getConfig();
    cors(req, res, config);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "x-request-id": requestId }).end();
      return;
    }
    try {
      if (req.method !== "GET") {
        throw new OpenAiError(405, "invalid_request_error", "method_not_allowed", "Method not allowed");
      }
      authenticate(req, deps);
      json(res, 200, {
        object: "list",
        data: [{
          id: "auto-tier",
          object: "model",
          created: 0,
          owned_by: "deepseek-harness",
        }],
      }, requestId);
    } catch (error) {
      const mapped = asOpenAiError(error);
      json(res, mapped.status, errorBody(mapped), requestId);
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    const config = deps.getConfig();
    cors(req, res, config);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "x-request-id": requestId }).end();
      return;
    }
    let release: (() => void) | undefined;
    let status = 500;
    let result: CompletionResult | undefined;
    try {
      if (req.method !== "POST") {
        throw new OpenAiError(405, "invalid_request_error", "method_not_allowed", "Method not allowed");
      }
      authenticate(req, deps);
      const request = parseChatCompletionRequest(await readJson(req, config.maxRequestBodyBytes));
      release = acquire(config.maxConcurrentRequests);
      if (!release) {
        throw new OpenAiError(429, "rate_limit_error", "concurrency_limit", "Gateway concurrency limit reached");
      }
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", onClose);
      try {
        result = await deps.run(request, config, controller.signal);
      } finally {
        res.off("close", onClose);
      }
      status = 200;
      if (request.stream) {
        writeBufferedSse(res, result, request.streamOptions.includeUsage, requestId);
      } else {
        json(res, status, completionBody(result), requestId);
      }
    } catch (error) {
      const mapped = asOpenAiError(error);
      status = mapped.status;
      json(res, status, errorBody(mapped), requestId);
    } finally {
      release?.();
      deps.log({
        requestId,
        status,
        latencyMs: Date.now() - started,
        ...(result ? {
          finishReason: result.finishReason,
          initialTier: result.routing.initialTier,
          finalTier: result.routing.finalTier,
          escalations: result.routing.escalations,
          usage: result.usage,
        } : {}),
      });
    }
  }

  async function notFound(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    cors(req, res, deps.getConfig());
    try {
      authenticate(req, deps);
      throw new OpenAiError(404, "invalid_request_error", "not_found", "Unknown OpenAI gateway route");
    } catch (error) {
      const mapped = asOpenAiError(error);
      json(res, mapped.status, errorBody(mapped), requestId);
    }
  }

  return { models, chatCompletions, notFound };
}
