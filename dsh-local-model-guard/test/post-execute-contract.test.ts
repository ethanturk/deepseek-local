import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.ts";

test("post-execute accepts DSH's exec, result, next signature", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ctx = {
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const handler = handlers.get("tools/post-execute");
  assert.ok(handler);

  const decision = { kind: "accept" };
  let called = false;
  const actual = await handler(
    { agentId: "agent-1", name: "Bash", arguments: { command: "pwd" } },
    { isError: false, content: "ok" },
    async () => {
      called = true;
      return decision;
    },
  );

  assert.equal(called, true);
  assert.equal(actual, decision);
  assert.equal(handlers.has("tools/result"), false);
});

test("repeated tools add recovery to the pre-step decision", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let inboxInjections = 0;
  const ctx = {
    agents: {
      get() {
        return { inject() { inboxInjections += 1; } };
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const postExecute = handlers.get("tools/post-execute");
  const preStep = handlers.get("agent/pre-step");
  assert.ok(postExecute);
  assert.ok(preStep);

  const exec = { agentId: "agent-1", name: "run_code", arguments: { code: "same" } };
  const result = { isError: false, content: "ok" };
  const accept = async () => ({ kind: "accept" });
  await postExecute(exec, result, accept);
  await postExecute(exec, result, accept);

  const decision = await preStep(
    { agentId: "agent-1", messages: [] },
    async () => ({ kind: "enter", messages: [] }),
  ) as { kind: string; messages: Array<{ content: unknown }> };

  assert.equal(inboxInjections, 0);
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 1);
  assert.match(JSON.stringify(decision.messages[0].content), /repeated tool signature/);
});

test("context pressure compacts at the configured model-window threshold", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const compactCalls: Array<{ trigger: string; signal: AbortSignal }> = [];
  const signal = new AbortController().signal;
  const agent = { id: "agent-1", session: {} };
  const ctx = {
    compaction: {
      async compactIfNeeded(_agent: unknown, trigger: string, activeSignal: AbortSignal) {
        compactCalls.push({ trigger, signal: activeSignal });
        return { compacted: true };
      },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 100 } };
      },
    },
    modelRouter: {
      getCurrentTier() { return "fast"; },
      getTierConfig() {
        return { provider: "local", model: "local-fast", enableLocalGuardrails: true };
      },
      isLocalGuardrailsEnabled() { return true; },
    },
    tokenMeter: {
      measure() { return { totalTokens: 90 }; },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    contextPressureThreshold: 0.9,
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const preStep = handlers.get("agent/pre-step");
  assert.ok(preStep);
  await preStep(
    { agent, messages: [], signal },
    async () => ({ kind: "enter", messages: [] }),
  );

  assert.deepEqual(compactCalls, [{ trigger: "pressure", signal }]);
});

test("context pressure stays idle below threshold", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let compactCalls = 0;
  let measureCalls = 0;
  const ctx = {
    compaction: {
      async compactIfNeeded() { compactCalls += 1; },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 100 } };
      },
    },
    modelRouter: {
      getCurrentTier() { return "fast"; },
      getTierConfig() {
        return { provider: "local", model: "local-fast", enableLocalGuardrails: true };
      },
      isLocalGuardrailsEnabled() { return true; },
    },
    tokenMeter: {
      measure() {
        measureCalls += 1;
        return { totalTokens: 89 };
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    contextPressureThreshold: 0.9,
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  await handlers.get("agent/pre-step")?.(
    { agent: { id: "agent-1", session: {} }, messages: [], signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [] }),
  );

  assert.equal(measureCalls, 1);
  assert.equal(compactCalls, 0);
});

test("failed context-pressure compaction escalates once per turn", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let compactCalls = 0;
  const escalations: string[] = [];
  const ctx = {
    compaction: {
      async compactIfNeeded() {
        compactCalls += 1;
        throw new Error("summarization produced no text summary content");
      },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 100 } };
      },
    },
    modelRouter: {
      getCurrentTier() { return "fast"; },
      getTierConfig() {
        return { provider: "local", model: "local-fast", enableLocalGuardrails: true };
      },
      isLocalGuardrailsEnabled() { return true; },
      escalateTier(_agentId: string, reason: string) {
        escalations.push(reason);
        return "medium";
      },
    },
    tokenMeter: {
      measure() { return { totalTokens: 95 }; },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    contextPressureThreshold: 0.9,
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const preStep = handlers.get("agent/pre-step");
  assert.ok(preStep);
  const claim = {
    agent: { id: "agent-1", session: {} },
    messages: [],
    signal: new AbortController().signal,
  };
  const next = async () => ({ kind: "enter", messages: [] });
  await preStep(claim, next);
  await preStep(claim, next);

  assert.equal(compactCalls, 1);
  assert.deepEqual(escalations, [
    "CONTEXT_PRESSURE_COMPACTION_FAILED: 95/100 tokens: summarization produced no text summary content",
  ]);
});

test("context pressure threshold rejects values outside zero to one", () => {
  const ctx = {
    on() {},
  };

  assert.throws(
    () => apply(ctx as any, { contextPressureThreshold: 1.1 }),
    /contextPressureThreshold must be greater than 0 and at most 1/,
  );
});

test("context pressure threshold is sourced from DSH settings", () => {
  const registrations: string[] = [];
  const ctx = {
    effect() {},
    inject(_services: string[], install: (settingsCtx: unknown) => void) {
      install({
        effect() {},
        settings: {
          register(namespace: string) {
            registrations.push(namespace);
            return {
              get() { return { contextPressureThreshold: 0.95 }; },
              watch() { return () => {}; },
            };
          },
        },
      });
    },
    on() {},
  };

  apply(ctx as any, { contextPressureThreshold: 0.9 });

  assert.deepEqual(registrations, ["local-model-guard"]);
});

test("opaque subagent tool failure escalates the next model request", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const escalations: Array<{ agentId: string; reason: string }> = [];
  const events: Array<Record<string, unknown>> = [];
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier(agentId: string, reason: string) {
        escalations.push({ agentId, reason });
        return "medium";
      },
    },
    sessions: {
      appendEvent(event: Record<string, unknown>) { events.push(event); },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const handler = handlers.get("tools/post-execute");
  assert.ok(handler);
  await handler(
    { agentId: "agent-1", name: "subagent", arguments: { description: "inspect failure" } },
    { isError: true, error: new Error("subagent run failed") },
    async () => ({ kind: "accept" }),
  );

  const preStep = handlers.get("agent/pre-step");
  assert.ok(preStep);
  const nextStep = await preStep(
    { agentId: "agent-1", messages: [] },
    async () => ({ kind: "enter", messages: [] }),
  ) as { kind: string; messages: Array<{ content: unknown }> };
  assert.equal(nextStep.kind, "enter");
  assert.equal(nextStep.messages.length, 1);
  assert.match(JSON.stringify(nextStep.messages[0].content), /Retry the delegated task exactly once/);

  assert.deepEqual(escalations, [{
    agentId: "agent-1",
    reason: "SUBAGENT_RUN_FAILED: subagent run failed",
  }]);
  assert.equal(events.some((event) => event.type === "local-guard/subagent-failure-escalate" && event.tierId === "medium"), true);
});

test("invalid ask arguments escalate but user aborts do not", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const escalations: Array<{ agentId: string; reason: string }> = [];
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier(agentId: string, reason: string) {
        escalations.push({ agentId, reason });
        return "smart";
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const postExecute = handlers.get("tools/post-execute");
  const preStep = handlers.get("agent/pre-step");
  assert.ok(postExecute);
  assert.ok(preStep);
  const exec = {
    agentId: "agent-1",
    name: "ask_user_question",
    arguments: { todos: [] },
  };
  await postExecute(
    exec,
    {
      isError: true,
      error: { code: "INVALID_ARGS", message: "missing required property questions" },
    },
    async () => ({ kind: "accept" }),
  );
  await postExecute(
    exec,
    {
      isError: true,
      error: { code: "ASK_ABORTED", message: "user cancelled" },
    },
    async () => ({ kind: "accept" }),
  );

  assert.deepEqual(escalations, [{
    agentId: "agent-1",
    reason: "ASK_USER_QUESTION_INVALID_ARGS: missing required property questions",
  }]);
  const decision = await preStep(
    { agentId: "agent-1", messages: [] },
    async () => ({ kind: "enter", messages: [] }),
  ) as { kind: string; messages: Array<{ content: unknown }> };
  assert.match(JSON.stringify(decision.messages[0].content), /Ask the user once/);
});

test("a model step cannot execute two ask calls", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const escalations: string[] = [];
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier(_agentId: string, reason: string) {
        escalations.push(reason);
        return "smart";
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const execute = handlers.get("tools/execute");
  assert.ok(execute);
  const exec = {
    agentId: "agent-1",
    name: "ask_user_question",
    arguments: { questions: [{ id: "choice", question: "Which?" }] },
  };
  assert.deepEqual(await execute(exec, async () => ({ kind: "accept" })), {
    kind: "accept",
  });
  await assert.rejects(
    execute(exec, async () => ({ kind: "accept" })),
    /Only one ask_user_question call is allowed per model step/,
  );
  assert.deepEqual(escalations, ["DUPLICATE_ASK_USER_QUESTION"]);
});

test("user-aborted asks do not trigger failure recovery", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier() { return "smart"; },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const postExecute = handlers.get("tools/post-execute");
  const preStep = handlers.get("agent/pre-step");
  assert.ok(postExecute);
  assert.ok(preStep);
  const exec = { agentId: "agent-1", name: "ask_user_question" };
  const aborted = {
    isError: true,
    error: { code: "ASK_ABORTED", message: "user cancelled" },
  };
  await postExecute(exec, aborted, async () => ({ kind: "accept" }));
  await postExecute(exec, aborted, async () => ({ kind: "accept" }));

  assert.deepEqual(
    await preStep(
      { agentId: "agent-1", messages: [] },
      async () => ({ kind: "enter", messages: [] }),
    ),
    { kind: "enter", messages: [] },
  );
});

test("unrecovered model failures escalate and retry on the next tier", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const escalations: Array<{ agentId: string; reason: string; signal: AbortSignal }> = [];
  const signal = new AbortController().signal;
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier(agentId: string, reason: string, activeSignal: AbortSignal) {
        escalations.push({ agentId, reason, signal: activeSignal });
        return "smart";
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const handler = handlers.get("agent/request-error");
  assert.ok(handler);
  const actual = await handler(
    {
      agent: { id: "agent-1" },
      failure: {
        code: "CONTEXT_WINDOW_EXCEEDED",
        message: "request exceeds context size",
      },
      signal,
    },
    async () => undefined,
  );

  assert.deepEqual(actual, { kind: "retry" });
  assert.deepEqual(escalations, [{
    agentId: "agent-1",
    reason: "CONTEXT_WINDOW_EXCEEDED: request exceeds context size",
    signal,
  }]);
});

test("context overflow gets one fallback retry after compaction declines", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const escalations: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier(_agentId: string, reason: string) {
        escalations.push(reason);
        return "medium";
      },
    },
    sessions: {
      appendEvent(event: Record<string, unknown>) { events.push(event); },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const requestError = handlers.get("agent/request-error");
  assert.ok(requestError);
  const payload = {
    agent: { id: "agent-1" },
    failure: {
      code: "CONTEXT_WINDOW_EXCEEDED",
      message: "request exceeds context size",
    },
    signal: new AbortController().signal,
  };
  const declineCompaction = async () => undefined;

  assert.deepEqual(await requestError(payload, declineCompaction), {
    kind: "retry",
  });
  assert.equal(await requestError(payload, declineCompaction), undefined);
  assert.equal(escalations.length, 1);
  assert.equal(
    events.some((event) =>
      event.type === "local-guard/context-overflow-retry-exhausted"
    ),
    true,
  );

  handlers.get("turn/end")?.({ agentId: "agent-1" });
  assert.deepEqual(await requestError(payload, declineCompaction), {
    kind: "retry",
  });
  assert.equal(escalations.length, 2);
});

test("existing request recovery wins without escalation", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let escalations = 0;
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier() {
        escalations += 1;
        return "medium";
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const handler = handlers.get("agent/request-error");
  assert.ok(handler);
  const actual = await handler(
    {
      agent: { id: "agent-1" },
      failure: { code: "RATE_LIMITED", message: "slow down" },
      signal: new AbortController().signal,
    },
    async () => ({ kind: "retry" }),
  );

  assert.deepEqual(actual, { kind: "retry" });
  assert.equal(escalations, 0);
});

test("broken downstream recovery does not mask the model failure", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let escalations = 0;
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier() {
        escalations += 1;
        return "smart";
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const handler = handlers.get("agent/request-error");
  assert.ok(handler);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let actual: unknown;
  try {
    actual = await handler(
      {
        agent: { id: "agent-1" },
        failure: { code: "MODEL_ERROR", message: "original model failure" },
        signal: new AbortController().signal,
      },
      async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'includes')");
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(actual, { kind: "retry" });
  assert.equal(escalations, 1);
  assert.match(String(warnings[0]?.[0]), /preserving the original model failure/);
});

test("reasoning-only terminal responses escalate and steer once per turn", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const escalations: string[] = [];
  const steers: any[] = [];
  let messages = [{
    role: "assistant",
    content: [{ type: "reasoning", text: "Hidden analysis only" }],
  }];
  const agent = {
    id: "agent-1",
    session: { deriveMessages: () => messages },
    steer(message: unknown) { steers.push(message); },
  };
  const ctx = {
    modelRouter: {
      isLocalGuardrailsEnabled() { return true; },
      escalateTier(_agentId: string, reason: string) {
        escalations.push(reason);
        return "medium";
      },
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  };

  apply(ctx as any, {
    enableRetries: false,
    enableSystemPromptHint: false,
    forceAlways: true,
  });

  const turnStopping = handlers.get("agent/turn-stopping");
  const turnEnd = handlers.get("turn/end");
  assert.ok(turnStopping);
  assert.ok(turnEnd);
  await turnStopping({ agent });
  await turnStopping({ agent });

  assert.deepEqual(escalations, ["EMPTY_ASSISTANT_RESPONSE"]);
  assert.equal(steers.length, 1);
  assert.match(JSON.stringify(steers[0]), /visible answer/);

  turnEnd({ agentId: "agent-1" });
  messages = [{ role: "assistant", content: [{ type: "text", text: "Done" }] }];
  await turnStopping({ agent });
  assert.equal(escalations.length, 1);
});
