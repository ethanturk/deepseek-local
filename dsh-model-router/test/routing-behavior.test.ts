import assert from "node:assert/strict";
import test from "node:test";

import { apply as applyRouter } from "../src/index.ts";

type Handler = (payload: any, next?: () => unknown) => unknown;

function createHarness(options: {
  classifierMode?: "heuristic" | "llm" | "both";
  generate?: (options: any) => Promise<unknown>;
}) {
  const handlers = new Map<string, Handler>();
  const settings = {
    tiers: [
      {
        id: "fast",
        provider: "local",
        model: "local-fast",
        enableLocalGuardrails: true,
      },
      {
        id: "medium",
        provider: "local",
        model: "local-medium",
        enableLocalGuardrails: true,
      },
      {
        id: "smart",
        provider: "remote",
        model: "remote-smart",
        enableLocalGuardrails: false,
      },
    ],
    classifier: {
      mode: options.classifierMode ?? "both",
      provider: "remote",
      model: "remote-classifier",
    },
    validator: {
      alwaysUseTierId: "smart",
      maxEscalations: 2,
      stickyScope: "turn",
    },
  };
  const ctx = {
    agents: {},
    effect() { return () => {}; },
    inject(_dependencies: string[], callback: (context: unknown) => void) {
      callback(this);
    },
    llm: {
      registerAdapter() {},
      generate: options.generate,
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    provide() {},
    sessions: {},
    settings: {
      register() {
        return {
          get: () => settings,
          watch() {},
        };
      },
    },
    systemPrompt: { section() {} },
    tools: {},
  };

  applyRouter(ctx as never);
  return handlers;
}

test("both mode uses recent context and keeps the higher classifier result", async () => {
  let classifierPrompt = "";
  const handlers = createHarness({
    generate: async (options) => {
      classifierPrompt = options.messages[0].content;
      return { content: "medium" };
    },
  });

  await handlers.get("agent/pre-step")?.(
    {
      agent: { id: "context-agent" },
      messages: [
        { role: "user", content: "Refactor the authentication flow safely." },
        { role: "assistant", content: "I inspected the current implementation." },
        { role: "user", content: "Fix it" },
      ],
    },
    () => undefined,
  );

  const selection = await handlers.get("agent/request")?.(
    { agent: { id: "context-agent" } },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );

  assert.match(classifierPrompt, /Refactor the authentication flow safely/);
  assert.match(classifierPrompt, /Fix it/);
  assert.deepEqual(selection, {
    provider: "local",
    model: "local-medium",
  });
});

test("failed validation steers regeneration on the next tier", async () => {
  const steered: unknown[] = [];
  const handlers = createHarness({
    classifierMode: "heuristic",
    generate: async () => ({ content: "FAIL: Missing regression coverage" }),
  });
  const agent = {
    id: "validation-agent",
    session: {
      deriveMessages: () => [
        { role: "user", content: "Fix it" },
        { role: "assistant", content: "Changed the implementation." },
      ],
    },
    steer(message: unknown) {
      steered.push(message);
    },
  };

  await handlers.get("agent/pre-step")?.(
    { agent, messages: agent.session.deriveMessages() },
    () => undefined,
  );
  await handlers.get("agent/turn-stopping")?.({
    agent,
    turn: 1,
    signal: new AbortController().signal,
  });

  const selection = await handlers.get("agent/request")?.(
    { agent },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );

  assert.equal(steered.length, 1);
  assert.deepEqual(selection, {
    provider: "local",
    model: "local-medium",
  });
});
