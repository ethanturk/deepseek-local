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
