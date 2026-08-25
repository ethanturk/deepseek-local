import assert from "node:assert/strict";
import test from "node:test";

import { apply as applyRouter } from "../src/index.ts";

type Handler = (payload: any, next?: () => unknown) => unknown;
type TestHandlers = Map<string, Handler> & {
  adapter?: any;
  modelRouter?: any;
};

function createHarness(options: {
  classifierMode?: "heuristic" | "llm" | "both";
  stream?: (options: any) => AsyncIterable<unknown>;
  resolveModelInfo?: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  activeAgentId?: string;
}) {
  const handlers = new Map<string, Handler>() as TestHandlers;
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
    agents: {
      currentAgent: () => options.activeAgentId
        ? { id: options.activeAgentId }
        : undefined,
    },
    effect() { return () => {}; },
    inject(_dependencies: string[], callback: (context: unknown) => void) {
      callback(this);
    },
    llm: {
      registerAdapter(_providers: string[], adapter: unknown) {
        handlers.adapter = adapter;
      },
      resolveModelInfo: options.resolveModelInfo,
      stream: options.stream,
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    provide(service: string, implementation: unknown) {
      if (service === "modelRouter") handlers.modelRouter = implementation;
    },
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

test("model failure escalation advances the tier for the active request", async () => {
  const signal = new AbortController().signal;
  const routedModels: string[] = [];
  const handlers = createHarness({
    activeAgentId: "failure-agent",
    stream: async function* (options) {
      routedModels.push(`${options.provider}/${options.model}`);
    },
  });

  handlers.modelRouter.forceTier("failure-agent", "fast");
  assert.equal(
    handlers.modelRouter.escalateTier(
      "failure-agent",
      "CONTEXT_WINDOW_EXCEEDED",
      signal,
    ),
    "medium",
  );

  for await (const _chunk of handlers.adapter.stream({
    provider: "auto-tier",
    model: "auto-tier",
    messages: [],
    signal,
  })) {}

  assert.deepEqual(routedModels, ["local/local-medium"]);
});

test("virtual model exposes metadata for the tier selected during pre-step", async () => {
  const signal = new AbortController().signal;
  const resolvedRoutes: string[] = [];
  const handlers = createHarness({
    resolveModelInfo: async (provider, model) => {
      resolvedRoutes.push(`${provider}/${model}`);
      return {
        provider,
        id: model,
        name: "Smart model",
        inputModalities: ["text", "image"],
        context: { contextWindow: 131_072 },
        defaultMaxTokens: 16_384,
        reasoning: {
          efforts: [{ id: "high", name: "High" }],
          defaultEffort: "high",
        },
      };
    },
    stream: async function* (options) {
      if (options.provider === "remote" && options.model === "remote-classifier") {
        yield* textStream("hard");
      }
    },
  });
  const messages = [
    { role: "user", content: "Refactor the authentication flow safely." },
  ];
  const agent = {
    id: "metadata-agent",
    session: { deriveMessages: () => messages },
  };

  await handlers.get("agent/pre-step")?.(
    { agent, messages, signal },
    () => undefined,
  );
  const metadata = await handlers.adapter.resolveModel(
    "auto-tier",
    "auto-tier",
    signal,
  );

  assert.deepEqual(metadata, {
    provider: "auto-tier",
    id: "auto-tier",
    name: "Auto (Tiered Router)",
    description: "Automatic tiered routing (fast → medium → smart)",
    inputModalities: ["text", "image"],
    context: { contextWindow: 131_072 },
    defaultMaxTokens: 16_384,
    reasoning: {
      efforts: [{ id: "high", name: "High" }],
      defaultEffort: "high",
    },
  });
  assert.deepEqual(resolvedRoutes, ["remote/remote-smart"]);

  const laterStepSignal = new AbortController().signal;
  await handlers.get("agent/pre-step")?.(
    { agent, messages: [], signal: laterStepSignal },
    () => undefined,
  );
  await handlers.adapter.resolveModel(
    "auto-tier",
    "auto-tier",
    laterStepSignal,
  );

  assert.deepEqual(resolvedRoutes, [
    "remote/remote-smart",
    "remote/remote-smart",
  ]);
});

test("virtual route stays selected while its adapter delegates to the chosen tier", async () => {
  let routedOptions: any;
  const signal = new AbortController().signal;
  const handlers = createHarness({
    stream: async function* (options) {
      if (options.provider === "remote" && options.model === "remote-classifier") {
        yield* textStream("hard");
        return;
      }
      routedOptions = options;
      yield* textStream("routed response");
    },
  });
  const agent = {
    id: "route-agent",
    session: {
      deriveMessages: () => [
        { role: "user", content: "Refactor the authentication flow safely." },
      ],
    },
  };

  await handlers.get("agent/pre-step")?.(
    { agent, messages: agent.session.deriveMessages() },
    () => undefined,
  );
  const selection = await handlers.get("agent/request")?.(
    { agent, signal },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );
  const chunks = [];
  for await (const chunk of handlers.adapter.stream({
    provider: "auto-tier",
    model: "auto-tier",
    messages: agent.session.deriveMessages(),
    tools: [{ name: "read" }],
    signal,
  })) {
    chunks.push(chunk);
  }

  assert.deepEqual(selection, { provider: "auto-tier", model: "auto-tier" });
  assert.equal(routedOptions.provider, "remote");
  assert.equal(routedOptions.model, "remote-smart");
  assert.deepEqual(routedOptions.tools, [{ name: "read" }]);
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
});

function modelPrompt(options: any): string | null {
  const message = options.messages?.[0];
  const text = message?.content?.find?.((block: any) => block?.type === "text")?.text;
  return typeof message?.id === "string" &&
    message.role === "user" &&
    message.source?.kind === "plugin" &&
    message.source.plugin === "dsh-model-router" &&
    typeof text === "string"
    ? text
    : null;
}

async function* textStream(text: string) {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
  yield { type: "finish", reason: { kind: "stop" } };
}

test("both mode keeps human prompts when synthetic user messages fill session history", async () => {
  let classifierPrompt = "";
  const handlers = createHarness({
    stream: async function* (options) {
      classifierPrompt = modelPrompt(options) ?? "";
      if (!classifierPrompt) {
        yield { type: "finish", reason: { kind: "error", message: "invalid message" } };
        return;
      }
      yield* textStream(
        classifierPrompt.includes("Refactor the authentication flow safely.")
          ? "medium"
          : "simple",
      );
    },
  });
  const syntheticNoise = [
    {
      role: "user",
      content: "Current runtime context supersedes earlier snapshots.",
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" },
    },
    {
      role: "user",
      content: "<system-reminder>Skill catalog</system-reminder>",
      source: { kind: "skill-catalog" },
    },
    { role: "assistant", content: "Inspecting implementation." },
    {
      role: "user",
      content: "You are repeating the exact same tool call.",
      source: { kind: "plugin", plugin: "repeat-tool-reminder" },
    },
    { role: "assistant", content: "Trying another approach." },
    {
      role: "user",
      content: "Tool calls failed or repeated.",
      source: { kind: "plugin", plugin: "dsh-local-model-guard" },
    },
  ];
  const conversation = [
    {
      role: "user",
      content: "Refactor the authentication flow safely.",
      source: { kind: "user" },
    },
    ...syntheticNoise,
    { role: "assistant", content: "I inspected the current implementation." },
    { role: "user", content: "Fix it", source: { kind: "user" } },
  ];
  const agent = {
    id: "context-agent",
    session: { deriveMessages: () => conversation },
  };

  await handlers.get("agent/pre-step")?.(
    {
      agent,
      messages: [{ role: "user", content: "Fix it", source: { kind: "user" } }],
    },
    () => undefined,
  );

  const selection = await handlers.get("agent/request")?.(
    { agent },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );

  assert.match(classifierPrompt, /Refactor the authentication flow safely/);
  assert.match(classifierPrompt, /Fix it/);
  assert.doesNotMatch(classifierPrompt, /Current runtime context/);
  assert.doesNotMatch(classifierPrompt, /Skill catalog/);
  assert.doesNotMatch(classifierPrompt, /repeating the exact same tool call/);
  assert.doesNotMatch(classifierPrompt, /Tool calls failed or repeated/);
  assert.deepEqual(selection, {
    provider: "auto-tier",
    model: "auto-tier",
  });
});

test("non-string model text deltas cannot break classifier routing", async () => {
  const handlers = createHarness({
    stream: async function* (options) {
      if (modelPrompt(options)) {
        yield { type: "text-delta", text: Symbol("malformed") };
        yield* textStream("hard");
      }
    },
  });
  const message = { role: "user", content: "Hello", source: { kind: "user" } };
  const agent = { id: "malformed-classifier-agent", session: { deriveMessages: () => [message] } };

  await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

  assert.equal(handlers.modelRouter.getState(agent.id)?.currentTierId, "smart");
});

test("classifier warnings preserve provider finish error details", async () => {
  const handlers = createHarness({
    stream: async function* (options) {
      if (modelPrompt(options)) {
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: {
              code: "token_expired",
              message: "Provided authentication token is expired.",
            },
          },
        };
      }
    },
  });
  const message = { role: "user", content: "Hello", source: { kind: "user" } };
  const agent = { id: "classifier-error-agent", session: { deriveMessages: () => [message] } };
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);
  } finally {
    console.warn = originalWarn;
  }

  const warningText = warnings.flat().map(String).join(" ");
  assert.match(warningText, /token_expired/);
  assert.match(warningText, /Provided authentication token is expired\./);
});

test("router diagnostics use stderr rather than the protocol stdout channel", () => {
  const handlers = createHarness({});
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: unknown[][] = [];
  const stderr: unknown[][] = [];
  console.log = (...args: unknown[]) => stdout.push(args);
  console.error = (...args: unknown[]) => stderr.push(args);
  try {
    handlers.adapter.providerInfo("auto-tier");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(stdout, []);
  assert.equal(stderr.length, 1);
  assert.match(String(stderr[0][0]), /adapter\.providerInfo/);
});

test("virtual provider delegates retry policy resolution to DSH", () => {
  const handlers = createHarness({});

  assert.equal(
    handlers.adapter.providerRetryPolicy("auto-tier"),
    undefined,
  );
});

test("malformed validator output is retried once then pauses automatic routing", async () => {
  let validatorAttempts = 0;
  const handlers = createHarness({
    activeAgentId: "malformed-validator-agent",
    classifierMode: "heuristic",
    stream: async function* (options) {
      if (modelPrompt(options)) {
        validatorAttempts += 1;
        yield* textStream("I will inspect the response before deciding.");
      }
    },
  });
  const messages = [
    { role: "user", content: "Fix the issue", source: { kind: "user" } },
    { role: "assistant", content: "A proposed fix." },
  ];
  const agent = {
    id: "malformed-validator-agent",
    session: { deriveMessages: () => messages },
  };

  await handlers.get("agent/pre-step")?.({ agent, messages: [messages[0]] }, () => undefined);
  await handlers.get("agent/turn-stopping")?.({ agent }, () => undefined);

  assert.equal(validatorAttempts, 2);
  assert.equal(handlers.modelRouter.getState(agent.id)?.routingPaused, true);
  await assert.rejects(async () => {
    for await (const _chunk of handlers.adapter.stream({
      provider: "auto-tier",
      model: "auto-tier",
      messages,
    })) {}
  }, /Automatic routing paused/);
});

test("failed validation steers regeneration on the next tier", async () => {
  const steered: unknown[] = [];
  const handlers = createHarness({
    classifierMode: "heuristic",
    stream: async function* (options) {
      if (!modelPrompt(options)) {
        yield { type: "finish", reason: { kind: "error", message: "invalid message" } };
        return;
      }
      yield* textStream('{"verdict":"fail","reason":"Missing regression coverage"}');
    },
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
    provider: "auto-tier",
    model: "auto-tier",
  });
});
