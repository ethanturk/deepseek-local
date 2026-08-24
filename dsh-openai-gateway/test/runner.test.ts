import assert from "node:assert/strict";
import test from "node:test";

import { parseChatCompletionRequest } from "../src/messages.ts";
import { createCompletionRunner } from "../src/runner.ts";
import { resolveConfig } from "../src/settings.ts";

function fakeRuntime(events: any[]) {
  let createOptions: any;
  let disposed = 0;
  const handlers = new Map<string, any>();
  const sections: any[] = [];
  const selections: any[] = [];
  const session = {
    events,
    append(type: string, data: any, opts?: any) {
      this.events.push({ type, data, ...opts });
    },
    deriveMessages() { return []; },
  };
  const agent: any = {
    id: "gateway-test",
    session,
    async whenIdle() {},
    followup() {},
    cancel() {},
  };
  const agentCtx: any = {
    agent,
    on(name: string, handler: any) { handlers.set(name, handler); return () => {}; },
    systemPrompt: { section(section: any) { sections.push(section); return () => {}; } },
    tools: {
      register() { return () => {}; },
      restrict() { return () => {}; },
      guard() { return () => {}; },
    },
  };
  const ctx: any = {
    tools: { schemas: () => [] },
    agents: {
      async create(options: any) {
        createOptions = options;
        await options.setup(agentCtx);
        return { agent, async dispose() { disposed += 1; } };
      },
    },
    modelRouter: {
      getState: () => ({ currentTierId: "medium", escalationCount: 1 }),
    },
  };
  const runner = createCompletionRunner({
    ctx,
    sessionId: (id: string) => id,
    installModelSelection(_agentCtx: any, selection: any) { selections.push(selection); return () => {}; },
  });
  return {
    runner,
    get createOptions() { return createOptions; },
    get disposed() { return disposed; },
    handlers,
    sections,
    selections,
  };
}

test("runs one disposable agent through the auto-tier virtual provider", async () => {
  const events = [
    {
      type: "assistant/message",
      data: {
        message: { content: [{ type: "text", text: "accepted answer" }] },
        usage: { inputTokens: 11, outputTokens: 5 },
      },
    },
    { type: "turn/end", data: { reason: { kind: "completed" } } },
  ];
  const runtime = fakeRuntime(events);
  const request = parseChatCompletionRequest({
    model: "auto-tier",
    messages: [
      { role: "system", content: "Be exact." },
      { role: "user", content: "hello" },
    ],
    temperature: 0.3,
    stop: ["END"],
    max_tokens: 100,
  });
  const result = await runtime.runner(request, resolveConfig({}), new AbortController().signal);

  assert.equal(runtime.createOptions.agentOptions.provider, "tiered-router");
  assert.equal(runtime.createOptions.agentOptions.model, "auto-tier");
  assert.equal(runtime.createOptions.agentOptions.maxTokens, 100);
  assert.deepEqual(runtime.selections[0].current, { provider: "tiered-router", model: "auto-tier" });
  assert.equal(runtime.sections[0].complete, true);
  const requestConfig = await runtime.handlers.get("agent/request")({}, async () => ({ provider: "x", model: "y" }));
  assert.equal(requestConfig.temperature, 0.3);
  assert.deepEqual(requestConfig.stop, ["END"]);
  assert.equal(result.content, "accepted answer");
  assert.equal(result.routing.initialTier, "fast");
  assert.equal(result.routing.finalTier, "medium");
  assert.equal(runtime.disposed, 1);
});

test("returns raw client tool calls from the accepted assistant message", async () => {
  const events = [{
    type: "assistant/message",
    data: {
      message: {
        content: [{
          type: "tool-call",
          id: "call_1",
          name: "get_weather",
          arguments: "{ \"city\": \"Chicago\" }",
        }],
      },
    },
  }];
  const runtime = fakeRuntime(events);
  const request = parseChatCompletionRequest({
    model: "auto-tier",
    messages: [{ role: "user", content: "weather" }],
    tools: [{
      type: "function",
      function: { name: "get_weather", parameters: { type: "object" } },
    }],
  });
  const result = await runtime.runner(request, resolveConfig({}), new AbortController().signal);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls[0].function.arguments, "{ \"city\": \"Chicago\" }");
});

test("disposes the ephemeral agent when response extraction fails", async () => {
  const runtime = fakeRuntime([]);
  const request = parseChatCompletionRequest({
    model: "auto-tier",
    messages: [{ role: "user", content: "hello" }],
  });
  await assert.rejects(
    runtime.runner(request, resolveConfig({}), new AbortController().signal),
    /no assistant response/,
  );
  assert.equal(runtime.disposed, 1);
});
