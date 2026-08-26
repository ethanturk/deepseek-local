import assert from "node:assert/strict";
import test from "node:test";

import { apply as applyRouter } from "../src/index.ts";
import type { UseCasesConfig } from "../src/types.ts";

type Handler = (payload: any, next?: () => unknown) => unknown;
type TestHandlers = Map<string, Handler> & {
  adapter?: any;
  modelRouter?: any;
  updateUseCases?: (useCases: UseCasesConfig) => void;
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
  parentAgentId?: string;
  useCases?: UseCasesConfig;
  sessionEvents?: Record<string, unknown>[];
}) {
  const handlers = new Map<string, Handler>() as TestHandlers;
  let settingsWatcher: (() => void) | undefined;
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
    useCases: options.useCases ?? { enabled: false, rules: [] },
  };
  const ctx = {
    fiber: { state: 0 },
    agents: {
      currentAgent: () => options.activeAgentId
        ? { id: options.activeAgentId }
        : undefined,
      currentInitiator: () => options.parentAgentId
        ? { id: options.parentAgentId }
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
    sessions: {
      appendEvent(event: Record<string, unknown>) {
        options.sessionEvents?.push(event);
      },
    },
    settings: {
      register() {
        return {
          get: () => settings,
          watch(callback: () => void) {
            settingsWatcher = callback;
          },
        };
      },
    },
    systemPrompt: { section() {} },
    tools: {},
  };

  applyRouter(ctx as never);
  handlers.updateUseCases = (useCases) => {
    settings.useCases = useCases;
    settingsWatcher?.();
  };
  return handlers;
}

test("subagent keeps inherited tier for its initial request", async () => {
  const handlers = createHarness({
    activeAgentId: "child-agent",
    parentAgentId: "parent-agent",
    stream: async function* (options) {
      if (options.provider === "remote" && options.model === "remote-classifier") {
        yield* textStream("hard");
      }
    },
  });
  handlers.modelRouter.forceTier("parent-agent", "smart");
  const messages = [{
    role: "user",
    content: "Perform a complex delegated repository audit.",
  }];
  const agent = {
    id: "child-agent",
    session: { deriveMessages: () => messages },
  };

  await handlers.get("agent/created")?.({ agent });
  await handlers.get("agent/pre-step")?.(
    { agent, messages, signal: new AbortController().signal },
    () => undefined,
  );
  const selection = await handlers.get("agent/request")?.(
    { agent, signal: new AbortController().signal },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );

  assert.deepEqual(selection, { provider: "auto-tier", model: "auto-tier" });
  assert.equal(handlers.modelRouter.getCurrentTier("child-agent"), "medium");
});

test("direct physical model stays outside routing and recovery", async () => {
  const handlers = createHarness({ activeAgentId: "direct-model-agent" });
  const agent = { id: "direct-model-agent" };
  const signal = new AbortController().signal;
  const directConfig = {
    provider: "litellm",
    model: "gpt-5.6-terra-high",
    reasoningEffort: "high",
    temperature: 0.2,
  };
  handlers.modelRouter.forceTier(agent.id, "smart");

  const selection = await handlers.get("agent/request")?.(
    { agent, signal },
    () => directConfig,
  );
  let delegated = false;
  const recovery = await handlers.get("agent/request-error")?.(
    {
      agent,
      signal,
      failure: {
        code: "PI_AI_ERROR",
        message: "The directly selected provider rejected the request.",
      },
    },
    () => {
      delegated = true;
      return undefined;
    },
  );

  assert.deepEqual(
    {
      selection,
      recovery,
      delegated,
      tier: handlers.modelRouter.getCurrentTier(agent.id),
    },
    {
      selection: directConfig,
      recovery: undefined,
      delegated: true,
      tier: "smart",
    },
  );
});

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

test("terminal smart-tier provider failure falls back once per turn", async () => {
  const handlers = createHarness({ activeAgentId: "provider-failure-agent" });
  const agent = { id: "provider-failure-agent" };
  const signal = new AbortController().signal;
  handlers.modelRouter.forceTier(agent.id, "smart");
  await handlers.get("agent/request")?.(
    { agent, signal },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );

  const decision = await handlers.get("agent/request-error")?.(
    {
      agent,
      signal,
      failure: {
        code: "PI_AI_ERROR",
        message: "The remote provider rejected the request.",
      },
    },
    () => undefined,
  );

  assert.deepEqual(decision, { kind: "retry" });
  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "medium");

  assert.equal(
    handlers.modelRouter.escalateTier(agent.id, "local retry failed", signal),
    "smart",
  );
  const repeated = await handlers.get("agent/request-error")?.(
    {
      agent,
      signal,
      failure: {
        code: "PI_AI_ERROR",
        message: "The remote provider rejected the retry.",
      },
    },
    () => undefined,
  );

  assert.equal(repeated, undefined);
  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "smart");

  await handlers.get("agent/turn-stopping")?.({ agent }, () => undefined);
  const nextTurnSignal = new AbortController().signal;
  await handlers.get("agent/request")?.(
    { agent, signal: nextTurnSignal },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );
  const nextTurn = await handlers.get("agent/request-error")?.(
    {
      agent,
      signal: nextTurnSignal,
      failure: {
        code: "PI_AI_ERROR",
        message: "The remote provider rejected a later request.",
      },
    },
    () => undefined,
  );

  assert.deepEqual(nextTurn, { kind: "retry" });
  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "medium");
});

test("reasoning-effort failure retries the same tier without delegating", async () => {
  const handlers = createHarness({ activeAgentId: "effort-failure-agent" });
  const agent = {
    id: "effort-failure-agent",
    inject() {},
  };
  handlers.modelRouter.forceTier(agent.id, "smart");
  const signal = new AbortController().signal;
  await handlers.get("agent/request")?.(
    { agent, signal },
    () => ({ provider: "auto-tier", model: "auto-tier" }),
  );
  let delegated = false;

  const decision = await handlers.get("agent/request-error")?.(
    {
      agent,
      signal,
      failure: {
        code: "UNSUPPORTED",
        message: "reasoning effort is unsupported",
      },
    },
    () => {
      delegated = true;
      return undefined;
    },
  );

  assert.deepEqual(decision, { kind: "retry" });
  assert.equal(delegated, false);
  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "smart");
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

test("virtual adapter prepares an RC2 model call", async () => {
  const routedModels: string[] = [];
  const signal = new AbortController().signal;
  const handlers = createHarness({
    activeAgentId: "prepare-agent",
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: "Fast model",
      context: { contextWindow: 131_072 },
    }),
    stream: async function* (options) {
      routedModels.push(`${options.provider}/${options.model}`);
      yield* textStream("prepared response");
    },
  });
  handlers.modelRouter.forceTier("prepare-agent", "fast");

  const prepared = await handlers.adapter.prepareCall(
    "auto-tier",
    "auto-tier",
    signal,
  );

  assert.deepEqual(prepared.model, {
    provider: "auto-tier",
    id: "auto-tier",
    name: "Auto (Tiered Router)",
    description: "Automatic tiered routing (fast → medium → smart)",
    context: { contextWindow: 131_072 },
  });
  const chunks = [];
  for await (const chunk of prepared.stream({
    provider: "auto-tier",
    model: "auto-tier",
    messages: [],
    signal,
  })) {
    chunks.push(chunk);
  }

  assert.deepEqual(routedModels, ["local/local-fast"]);
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

const readOnlyUseCases: UseCasesConfig = {
  enabled: true,
  rules: [{
    id: "read-only",
    tierId: "fast",
    description: "Read or paginate existing information without analysis or changes.",
    positiveExamples: ["Read src/index.ts", "Show ADO PR 81522 details"],
    negativeExamples: ["Review implementation after reading PR details"],
  }],
};

for (const [index, request] of [
  "Read src/index.ts",
  "Show ADO PR 81522 details",
  "I'll paginate through the threads",
].entries()) {
  test(`semantic use-case starts read-only request ${index + 1} on fast`, async () => {
    const events: Record<string, unknown>[] = [];
    let classifierMaxTokens = 0;
    const handlers = createHarness({
      useCases: readOnlyUseCases,
      sessionEvents: events,
      stream: async function* (options) {
        classifierMaxTokens = options.maxTokens;
        yield* textStream("use-case:read-only");
      },
    });
    const message = { role: "user", content: request, source: { kind: "user" } };
    const agent = {
      id: `semantic-read-only-${index}`,
      session: { deriveMessages: () => [message] },
    };

    await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

    assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "fast");
    assert.equal(
      handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId,
      "read-only",
    );
    assert.ok(events.some((event) =>
      event.type === "model-router/classify" &&
      event.reason === "use-case" &&
      event.useCaseId === "read-only" &&
      event.tierId === "fast"
    ));
    assert.ok(classifierMaxTokens > 8);
  });
}

test("disabled semantic use cases preserve legacy classifier behavior", async () => {
  const events: Record<string, unknown>[] = [];
  let classifierCalls = 0;
  let classifierPrompt = "";
  let classifierMaxTokens = 0;
  const handlers = createHarness({
    useCases: { ...readOnlyUseCases, enabled: false },
    sessionEvents: events,
    stream: async function* (options) {
      classifierCalls += 1;
      classifierPrompt = modelPrompt(options) ?? "";
      classifierMaxTokens = options.maxTokens;
      yield* textStream("use-case:read-only");
    },
  });
  const message = { role: "user", content: "Read src/index.ts", source: { kind: "user" } };
  const agent = { id: "disabled-use-case", session: { deriveMessages: () => [message] } };

  await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

  assert.doesNotMatch(classifierPrompt, /use-case:read-only/);
  assert.equal(classifierCalls, 1);
  assert.equal(classifierMaxTokens, 8);
  assert.equal(handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId, null);
  const classification = events.find((event) => event.type === "model-router/classify");
  assert.ok(classification);
  const { ts: _ts, ...eventWithoutTimestamp } = classification;
  assert.deepEqual(eventWithoutTimestamp, {
    type: "model-router/classify",
    agentId: agent.id,
    complexity: "simple",
    tierId: "fast",
    messagePreview: "Read src/index.ts",
  });
});

for (const [response, classifierMode, expectedTier, expectedComplexity] of [
  ["hard.", "llm", "smart", "hard"],
  ["The request is medium difficulty.", "both", "medium", "medium"],
  ["This is simple to answer.", "llm", "fast", "simple"],
] as const) {
  test(`disabled semantic routing accepts legacy classifier response: ${response}`, async () => {
    const handlers = createHarness({
      classifierMode,
      stream: async function* () {
        yield* textStream(response);
      },
    });
    const message = { role: "user", content: "Classify this request", source: { kind: "user" } };
    const agent = {
      id: `legacy-classifier-${expectedComplexity}`,
      session: { deriveMessages: () => [message] },
    };

    await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

    assert.equal(handlers.modelRouter.getCurrentTier(agent.id), expectedTier);
    assert.equal(
      handlers.modelRouter.getState(agent.id)?.lastClassification,
      expectedComplexity,
    );
  });
}

test("disabled semantic routing lets the existing classifier decide explicit wording", async () => {
  let classifierCalls = 0;
  const handlers = createHarness({
    stream: async function* () {
      classifierCalls += 1;
      yield* textStream("medium");
    },
  });
  const message = {
    role: "user",
    content: "Use the smart model to read PR 81522",
    source: { kind: "user" },
  };
  const agent = { id: "disabled-explicit-wording", session: { deriveMessages: () => [message] } };

  await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

  assert.equal(classifierCalls, 1);
  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "medium");
  assert.equal(handlers.modelRouter.getState(agent.id)?.lastClassification, "medium");
});

test("unknown semantic use case falls back to both-mode heuristic", async () => {
  const handlers = createHarness({
    useCases: readOnlyUseCases,
    stream: async function* () {
      yield* textStream("use-case:unknown");
    },
  });
  const message = { role: "user", content: "Show ADO PR 81522 details", source: { kind: "user" } };
  const agent = { id: "unknown-use-case", session: { deriveMessages: () => [message] } };

  await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "fast");
  assert.equal(handlers.modelRouter.getState(agent.id)?.lastClassification, "simple");
  assert.equal(handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId, null);
});

test("explicit smart-tier request outranks semantic use-case match", async () => {
  const handlers = createHarness({
    useCases: readOnlyUseCases,
    stream: async function* () {
      yield* textStream("use-case:read-only");
    },
  });
  const message = {
    role: "user",
    content: "Use the smart model to read PR 81522",
    source: { kind: "user" },
  };
  const agent = { id: "explicit-smart-use-case", session: { deriveMessages: () => [message] } };

  await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "smart");
  assert.equal(handlers.modelRouter.getState(agent.id)?.lastClassification, "hard");
  assert.equal(handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId, null);
});

test("mixed semantic request uses complexity and includes negative examples", async () => {
  let classifierPrompt = "";
  const handlers = createHarness({
    useCases: readOnlyUseCases,
    stream: async function* (options) {
      classifierPrompt = modelPrompt(options) ?? "";
      yield* textStream("medium");
    },
  });
  const message = {
    role: "user",
    content: "Read PR 81522 and review the implementation",
    source: { kind: "user" },
  };
  const agent = { id: "mixed-use-case", session: { deriveMessages: () => [message] } };

  await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "medium");
  assert.equal(handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId, null);
  assert.match(classifierPrompt, /Review implementation after reading PR details/);
});

for (const complexity of ["medium", "hard"] as const) {
  test(`${complexity} complexity clears previous semantic use-case match`, async () => {
    let classifierResponse = "use-case:read-only";
    let messages = [{ role: "user", content: "Show ADO PR 81522 details", source: { kind: "user" } }];
    const handlers = createHarness({
      useCases: readOnlyUseCases,
      stream: async function* () {
        yield* textStream(classifierResponse);
      },
    });
    const agent = { id: `clear-use-case-${complexity}`, session: { deriveMessages: () => messages } };
    await handlers.get("agent/pre-step")?.({ agent, messages }, () => undefined);
    assert.equal(handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId, "read-only");

    classifierResponse = complexity;
    messages = [
      ...messages,
      { role: "assistant", content: "PR details." } as any,
      { role: "user", content: "Review the implementation carefully", source: { kind: "user" } },
    ];
    await handlers.get("agent/pre-step")?.({ agent, messages }, () => undefined);

    assert.equal(handlers.modelRouter.getCurrentTier(agent.id), complexity === "hard" ? "smart" : "medium");
    assert.equal(handlers.modelRouter.getState(agent.id)?.lastClassification, complexity);
    assert.equal(handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId, null);
  });
}

test("hot reload enables semantic routing without reapplying plugin", async () => {
  const handlers = createHarness({
    useCases: { enabled: false, rules: [] },
    stream: async function* (options) {
      yield* textStream(
        (modelPrompt(options) ?? "").includes("use-case:read-only")
          ? "use-case:read-only"
          : "hard",
      );
    },
  });
  const firstMessage = { role: "user", content: "Show ADO PR 81522 details", source: { kind: "user" } };
  const firstAgent = { id: "before-use-case-reload", session: { deriveMessages: () => [firstMessage] } };
  await handlers.get("agent/pre-step")?.({ agent: firstAgent, messages: [firstMessage] }, () => undefined);
  assert.equal(handlers.modelRouter.getCurrentTier(firstAgent.id), "smart");

  handlers.updateUseCases?.(readOnlyUseCases);
  const secondMessage = { role: "user", content: "Show ADO PR 81522 details", source: { kind: "user" } };
  const secondAgent = { id: "after-use-case-reload", session: { deriveMessages: () => [secondMessage] } };
  await handlers.get("agent/pre-step")?.({ agent: secondAgent, messages: [secondMessage] }, () => undefined);

  assert.equal(handlers.modelRouter.getCurrentTier(secondAgent.id), "fast");
  assert.equal(handlers.modelRouter.getState(secondAgent.id)?.lastMatchedUseCaseId, "read-only");
  assert.equal(handlers.modelRouter.getCurrentTier(firstAgent.id), "smart");
});

test("classification uses one semantic settings snapshot across hot reload", async () => {
  let classifierCalls = 0;
  let releaseClassifier!: () => void;
  let markClassifierStarted!: () => void;
  const classifierStarted = new Promise<void>((resolve) => {
    markClassifierStarted = resolve;
  });
  const classifierRelease = new Promise<void>((resolve) => {
    releaseClassifier = resolve;
  });
  const handlers = createHarness({
    useCases: readOnlyUseCases,
    stream: async function* () {
      classifierCalls += 1;
      if (classifierCalls === 1) {
        markClassifierStarted();
        await classifierRelease;
        yield* textStream("use-case:read-only");
        return;
      }
      yield* textStream("hard.");
    },
  });
  const firstMessage = { role: "user", content: "Show ADO PR 81522 details", source: { kind: "user" } };
  const firstAgent = { id: "in-flight-use-case", session: { deriveMessages: () => [firstMessage] } };

  const inFlightClassification = handlers.get("agent/pre-step")?.(
    { agent: firstAgent, messages: [firstMessage] },
    () => undefined,
  );
  await classifierStarted;
  handlers.updateUseCases?.({ enabled: false, rules: [] });
  releaseClassifier();
  await inFlightClassification;

  assert.equal(handlers.modelRouter.getCurrentTier(firstAgent.id), "fast");
  assert.equal(
    handlers.modelRouter.getState(firstAgent.id)?.lastMatchedUseCaseId,
    "read-only",
  );

  const secondMessage = { role: "user", content: "Show ADO PR 81522 details", source: { kind: "user" } };
  const secondAgent = { id: "after-in-flight-reload", session: { deriveMessages: () => [secondMessage] } };
  await handlers.get("agent/pre-step")?.({ agent: secondAgent, messages: [secondMessage] }, () => undefined);

  assert.equal(handlers.modelRouter.getCurrentTier(secondAgent.id), "smart");
  assert.equal(handlers.modelRouter.getState(secondAgent.id)?.lastMatchedUseCaseId, null);
});

test("semantic use-case records initial reason without locking tier", async () => {
  const handlers = createHarness({
    useCases: readOnlyUseCases,
    stream: async function* () {
      yield* textStream("use-case:read-only");
    },
  });
  const message = { role: "user", content: "Show ADO PR 81522 details", source: { kind: "user" } };
  const agent = { id: "escalated-use-case", session: { deriveMessages: () => [message] } };
  await handlers.get("agent/pre-step")?.({ agent, messages: [message] }, () => undefined);

  assert.equal(
    handlers.modelRouter.escalateTier(agent.id, "read result needs more reasoning"),
    "medium",
  );
  assert.equal(handlers.modelRouter.getCurrentTier(agent.id), "medium");
  assert.equal(
    handlers.modelRouter.getState(agent.id)?.lastMatchedUseCaseId,
    "read-only",
  );
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
