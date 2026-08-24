import { randomUUID } from "node:crypto";

import { invalidRequest } from "./errors.ts";

type JsonObject = Record<string, unknown>;

export interface OpenAiFunctionTool {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAiPromptMessage = Extract<OpenAiMessage, { role: "user" | "tool" }>;

export interface ChatCompletionRequest {
  model: "auto-tier";
  messages: OpenAiMessage[];
  tools: OpenAiFunctionTool[];
  toolChoice: "auto" | "none";
  stream: boolean;
  streamOptions: { includeUsage: boolean };
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface BuiltConversation {
  system?: string;
  history: readonly OpenAiMessage[];
  prompt: OpenAiPromptMessage;
}

const REQUEST_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "n",
]);

function record(value: unknown, param: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidRequest(`${param} must be an object`, param);
  }
  return value as JsonObject;
}

function exactFields(value: JsonObject, allowed: ReadonlySet<string>, param: string): void {
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) invalidRequest(`unsupported field: ${unsupported}`, unsupported);
}

function nonemptyString(value: unknown, param: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidRequest(`${param} must be a nonempty string`, param);
  }
  return value;
}

function parseToolCall(value: unknown, param: string): OpenAiToolCall {
  const call = record(value, param);
  exactFields(call, new Set(["id", "type", "function"]), param);
  if (call.type !== "function") invalidRequest(`${param}.type must be function`, param);
  const fn = record(call.function, `${param}.function`);
  exactFields(fn, new Set(["name", "arguments"]), `${param}.function`);
  const rawArguments = nonemptyString(fn.arguments, `${param}.function.arguments`);
  try {
    record(JSON.parse(rawArguments), `${param}.function.arguments`);
  } catch (error) {
    if (error instanceof SyntaxError) invalidRequest(`${param}.function.arguments must be JSON`, param);
    throw error;
  }
  return {
    id: nonemptyString(call.id, `${param}.id`),
    type: "function",
    function: {
      name: nonemptyString(fn.name, `${param}.function.name`),
      arguments: rawArguments,
    },
  };
}

function parseMessage(value: unknown, index: number): OpenAiMessage {
  const param = `messages.${index}`;
  const message = record(value, param);
  const role = message.role;
  if (role === "system" || role === "user") {
    exactFields(message, new Set(["role", "content", "name"]), param);
    if (typeof message.content !== "string") {
      invalidRequest(`${param}.content must be text; image and multipart content are unsupported`, `${param}.content`);
    }
    return { role, content: message.content };
  }
  if (role === "assistant") {
    exactFields(message, new Set(["role", "content", "tool_calls", "name"]), param);
    if (message.content !== null && typeof message.content !== "string") {
      invalidRequest(`${param}.content must be text or null`, `${param}.content`);
    }
    const toolCalls = message.tool_calls === undefined
      ? undefined
      : Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call, callIndex) => parseToolCall(call, `${param}.tool_calls.${callIndex}`))
      : invalidRequest(`${param}.tool_calls must be an array`, `${param}.tool_calls`);
    if ((message.content === null || message.content === "") && (!toolCalls || toolCalls.length === 0)) {
      invalidRequest(`${param} must contain text or tool calls`, param);
    }
    return { role, content: message.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
  }
  if (role === "tool") {
    exactFields(message, new Set(["role", "content", "tool_call_id"]), param);
    if (typeof message.content !== "string") {
      invalidRequest(`${param}.content must be text`, `${param}.content`);
    }
    return {
      role,
      content: message.content,
      tool_call_id: nonemptyString(message.tool_call_id, `${param}.tool_call_id`),
    };
  }
  invalidRequest(`${param}.role is unsupported`, `${param}.role`);
}

function parseTools(value: unknown): OpenAiFunctionTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidRequest("tools must be an array", "tools");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const param = `tools.${index}`;
    const tool = record(entry, param);
    exactFields(tool, new Set(["type", "function"]), param);
    if (tool.type !== "function") invalidRequest(`${param}.type must be function`, param);
    const fn = record(tool.function, `${param}.function`);
    exactFields(fn, new Set(["name", "description", "parameters", "strict"]), `${param}.function`);
    const name = nonemptyString(fn.name, `${param}.function.name`);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) invalidRequest(`invalid tool name: ${name}`, `${param}.function.name`);
    if (names.has(name)) invalidRequest(`duplicate tool name: ${name}`, "tools");
    names.add(name);
    const parameters = record(fn.parameters, `${param}.function.parameters`);
    if (parameters.type !== "object") invalidRequest(`${param}.function.parameters.type must be object`, param);
    if (fn.description !== undefined && typeof fn.description !== "string") {
      invalidRequest(`${param}.function.description must be text`, param);
    }
    if (fn.strict !== undefined && typeof fn.strict !== "boolean") invalidRequest(`${param}.function.strict must be boolean`, param);
    return { name, description: fn.description ?? "", parameters };
  });
}

function parsePositiveInteger(value: unknown, param: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalidRequest(`${param} must be a positive integer`, param);
  return Number(value);
}

export function parseChatCompletionRequest(value: unknown): ChatCompletionRequest {
  const input = record(value, "body");
  exactFields(input, REQUEST_FIELDS, "body");
  if (input.model !== "auto-tier") invalidRequest("model must be auto-tier", "model");
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    invalidRequest("messages must be a nonempty array", "messages");
  }
  if (input.n !== undefined && input.n !== 1) invalidRequest("n must be 1", "n");
  if (input.tool_choice !== undefined && input.tool_choice !== "auto" && input.tool_choice !== "none") {
    invalidRequest("tool_choice supports only auto and none", "tool_choice");
  }
  if (input.stream !== undefined && typeof input.stream !== "boolean") invalidRequest("stream must be boolean", "stream");
  if (input.temperature !== undefined && (typeof input.temperature !== "number" || !Number.isFinite(input.temperature))) {
    invalidRequest("temperature must be a finite number", "temperature");
  }
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined) {
    invalidRequest("max_tokens and max_completion_tokens cannot both be set", "max_tokens");
  }
  const maxTokens = parsePositiveInteger(input.max_completion_tokens ?? input.max_tokens, "max_tokens");
  let stop: string[] | undefined;
  if (typeof input.stop === "string") stop = [input.stop];
  else if (Array.isArray(input.stop) && input.stop.every((item) => typeof item === "string")) stop = [...input.stop];
  else if (input.stop !== undefined) invalidRequest("stop must be a string or string array", "stop");

  let includeUsage = false;
  if (input.stream_options !== undefined) {
    const options = record(input.stream_options, "stream_options");
    exactFields(options, new Set(["include_usage"]), "stream_options");
    if (options.include_usage !== undefined && typeof options.include_usage !== "boolean") {
      invalidRequest("stream_options.include_usage must be boolean", "stream_options.include_usage");
    }
    includeUsage = options.include_usage === true;
  }

  return {
    model: "auto-tier",
    messages: input.messages.map(parseMessage),
    tools: parseTools(input.tools),
    toolChoice: (input.tool_choice as "auto" | "none" | undefined) ?? "auto",
    stream: input.stream === true,
    streamOptions: { includeUsage },
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(stop === undefined ? {} : { stop }),
  };
}

export function buildConversation(messages: readonly OpenAiMessage[]): BuiltConversation {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system");
  if (conversation.length === 0) invalidRequest("messages require a user or tool prompt", "messages");

  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const [index, message] of conversation.entries()) {
    if (message.role !== "tool" && pending.size > 0) {
      invalidRequest(`unresolved tool call before messages.${index}`, `messages.${index}`);
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (seen.has(call.id)) invalidRequest(`duplicate tool call id: ${call.id}`, `messages.${index}`);
        seen.add(call.id);
        pending.add(call.id);
      }
    } else if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) {
        invalidRequest(`tool result ${message.tool_call_id} has no preceding assistant call`, `messages.${index}`);
      }
    }
  }
  if (pending.size > 0) invalidRequest("unresolved tool call in message history", "messages");

  const prompt = conversation.at(-1)!;
  if (prompt.role !== "user" && prompt.role !== "tool") {
    invalidRequest("final message must have role user or tool", "messages");
  }
  return {
    ...(system ? { system } : {}),
    history: conversation.slice(0, -1),
    prompt,
  };
}

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

export function toPromptMessage(prompt: OpenAiPromptMessage): any {
  if (prompt.role === "user") {
    return {
      id: randomUUID(),
      role: "user",
      content: [textBlock(prompt.content)],
      source: { kind: "user" },
    };
  }
  return {
    id: randomUUID(),
    role: "user",
    content: [{
      type: "tool-result",
      toolCallId: prompt.tool_call_id,
      content: [textBlock(prompt.content)],
      isError: false,
    }],
    source: { kind: "tool", callId: prompt.tool_call_id },
  };
}

export function appendHistory(session: { append(type: string, data: any, opts?: any): unknown }, history: readonly OpenAiMessage[]): void {
  let turn = 0;
  let step = 0;
  for (const message of history) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      turn += 1;
      step = 0;
      session.append("user/message", toPromptMessage(message), { surfaceOp: "append" });
      continue;
    }
    if (message.role === "assistant") {
      step += 1;
      const content = [
        ...(message.content ? [textBlock(message.content)] : []),
        ...(message.tool_calls ?? []).map((call) => ({
          type: "tool-call" as const,
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      ];
      session.append("assistant/message", {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: "assistant",
          content,
          source: { kind: "model", provider: "tiered-router", model: "auto-tier" },
        },
      }, { surfaceOp: "append" });
      for (const call of message.tool_calls ?? []) {
        session.append("tool/call", {
          turn,
          step,
          callId: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    session.append("tool/result", {
      turn,
      step,
      message: toPromptMessage(message),
    }, { surfaceOp: "append" });
  }
}
