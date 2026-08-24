import assert from "node:assert/strict";
import test from "node:test";

import {
  appendHistory,
  buildConversation,
  parseChatCompletionRequest,
  toPromptMessage,
} from "../src/messages.ts";

test("parses only V1 fields DSH can honor", () => {
  const request = parseChatCompletionRequest({
    model: "auto-tier",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.2,
    max_completion_tokens: 256,
    stop: "END",
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(request.maxTokens, 256);
  assert.deepEqual(request.stop, ["END"]);
  assert.equal(request.streamOptions.includeUsage, true);
});

test("rejects unsupported and ambiguous request fields", () => {
  const base = { model: "auto-tier", messages: [{ role: "user", content: "hello" }] };
  assert.throws(() => parseChatCompletionRequest({ ...base, top_p: 0.9 }), /top_p/);
  assert.throws(() => parseChatCompletionRequest({ ...base, tool_choice: "required" }), /tool_choice/);
  assert.throws(() => parseChatCompletionRequest({ ...base, n: 2 }), /n/);
  assert.throws(() => parseChatCompletionRequest({
    ...base,
    max_tokens: 100,
    max_completion_tokens: 200,
  }), /max_tokens/);
});

test("validates and preserves client function tools", () => {
  const request = parseChatCompletionRequest({
    model: "auto-tier",
    messages: [{ role: "user", content: "weather" }],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    }],
  });
  assert.equal(request.tools[0].name, "get_weather");
  assert.throws(() => parseChatCompletionRequest({
    model: "auto-tier",
    messages: [{ role: "user", content: "x" }],
    tools: [
      { type: "function", function: { name: "same", parameters: { type: "object" } } },
      { type: "function", function: { name: "same", parameters: { type: "object" } } },
    ],
  }), /duplicate tool/);
});

test("builds ordered system text and separates the driving message", () => {
  const conversation = buildConversation([
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "next" },
  ]);
  assert.equal(conversation.system, "first\n\nsecond");
  assert.equal(conversation.history.length, 2);
  assert.deepEqual(conversation.prompt, { role: "user", content: "next" });
});

test("preserves assistant tool arguments and correlates tool results", () => {
  const rawArguments = "{ \"city\": \"Chicago\" }";
  const conversation = buildConversation([
    { role: "user", content: "weather" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: rawArguments },
      }],
    },
    { role: "tool", tool_call_id: "call_1", content: "sunny" },
  ]);
  const events: Array<{ type: string; data: any; opts?: any }> = [];
  appendHistory({ append(type: string, data: any, opts?: any) {
    events.push({ type, data, opts });
  } }, conversation.history);
  assert.equal(events.find((event) => event.type === "tool/call")?.data.arguments, rawArguments);
  const prompt = toPromptMessage(conversation.prompt);
  assert.equal(prompt.content[0].toolCallId, "call_1");
});

test("rejects malformed tool histories", () => {
  assert.throws(() => buildConversation([
    { role: "tool", tool_call_id: "missing", content: "x" },
  ]), /preceding assistant/);
  assert.throws(() => buildConversation([
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "dup", type: "function", function: { name: "a", arguments: "{}" } }],
    },
    { role: "user", content: "interrupt" },
  ]), /unresolved tool call/);
});
