import assert from "node:assert/strict";
import test from "node:test";

import {
  apply as applyGuard,
  inject as guardDependencies,
} from "../../dsh-local-model-guard/src/index.ts";
import {
  apply as applyRouter,
  inject as routerDependencies,
} from "../src/index.ts";

test("plugins register system prompt sections using the DSH name/text contract", () => {
  const sections: unknown[] = [];
  const ctx = {
    inject() {},
    llm: { registerAdapter() {} },
    on() {},
    provide() {},
    systemPrompt: { section(value: unknown) { sections.push(value); } },
  };

  applyRouter(ctx as never);
  applyGuard(ctx as never);

  assert.deepEqual(sections, [
    {
      name: "model-router-hint",
      order: 40,
      text: "You are running under an automatic tiered model router. Focus on the current task. Be precise and concise.",
    },
    {
      name: "local-model-guard-hint",
      order: 45,
      text:
        "Local/small model mode: prefer short precise tool calls. " +
        "On tool failure, do not retry the same call with the same arguments — change the approach.",
    },
  ]);
});

test("local guard requests the system prompt service used by its hint", () => {
  assert.ok(guardDependencies.includes("systemPrompt"));
});

test("model router reads tier assignments from live DSH settings", async () => {
  const handlers = new Map<string, (payload: unknown, next: () => unknown) => unknown>();
  let adapter: any;
  let routedConfig: any;
  const localSettings = {
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
        provider: "local",
        model: "local-smart",
        enableLocalGuardrails: true,
      },
    ],
    classifier: {
      mode: "both",
      provider: "local",
      model: "local-fast",
    },
  };
  const ctx = {
    agents: { currentAgent: () => ({ id: "test-agent" }) },
    effect() { return () => {}; },
    inject(_dependencies: string[], callback: (context: unknown) => void) {
      callback(this);
    },
    llm: {
      registerAdapter(_providers: string[], value: unknown) { adapter = value; },
      async *stream(config: unknown) {
        routedConfig = config;
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
    on(event: string, handler: (payload: unknown, next: () => unknown) => unknown) {
      handlers.set(event, handler);
    },
    provide() {},
    sessions: {},
    settings: {
      register() {
        return {
          get: () => localSettings,
          watch() {},
        };
      },
    },
    systemPrompt: { section() {} },
    tools: {},
  };

  applyRouter(ctx as never);

  const selection = await handlers.get("agent/request")?.(
    { agent: { id: "test-agent" } },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );

  assert.deepEqual(selection, {
    provider: "auto-tier",
    model: "auto-tier",
  });
  for await (const _chunk of adapter.stream({
    provider: "auto-tier",
    model: "auto-tier",
    messages: [],
  })) {}
  assert.equal(routedConfig.provider, "local");
  assert.equal(routedConfig.model, "local-medium");
});

test("model router requests the DSH settings service", () => {
  assert.ok(routerDependencies.includes("settings"));
});
