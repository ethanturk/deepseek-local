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
