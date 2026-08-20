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
