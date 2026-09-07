import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/index.ts";

type Handler = (payload: any, next?: () => unknown) => unknown;

function createCtx(options: { modelRouter?: unknown } = {}) {
  const handlers = new Map<string, Handler>();
  const provided = new Map<string, unknown>();
  const events: Record<string, unknown>[] = [];
  const ctx: any = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    provide(service: string, impl: unknown) {
      provided.set(service, impl);
    },
    sessions: {
      appendEvent(event: Record<string, unknown>) {
        events.push(event);
      },
    },
  };
  if (options.modelRouter !== undefined) ctx.modelRouter = options.modelRouter;
  return { ctx, handlers, provided, events };
}

function verifierResponse(letter: string) {
  return new Response(
    JSON.stringify({
      choices: [{
        message: { content: `<c1>${letter}</c1>` },
        logprobs: {
          content: [
            { token: "<c1>", logprob: -0.1 },
            {
              token: letter,
              logprob: 0,
              top_logprobs: [{ token: ` ${letter}`, logprob: 0 }],
            },
          ],
        },
      }],
    }),
    { status: 200 },
  );
}

function withFetch(letters: string[], fn: () => Promise<void> | void) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    const letter = letters[Math.min(calls++, letters.length - 1)];
    return Promise.resolve(verifierResponse(letter));
  }) as typeof fetch;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

function makeAgent(messages: any[], steered: unknown[]) {
  return {
    id: "agent-1",
    session: { deriveMessages: () => messages },
    steer(message: unknown) {
      steered.push(message);
    },
  };
}

const config = { model: "verifier-model", baseUrl: "http://v.test/v1" };

test("apply provides the llmVerifier service", () => {
  const { ctx, provided } = createCtx();
  apply(ctx, config);
  const service = provided.get("llmVerifier") as any;
  assert.ok(service);
  assert.equal(service.isConfigured(), true);
});

test("turn-stopping steers when the score is below threshold", async () => {
  const { ctx, handlers } = createCtx();
  apply(ctx, config);
  const steered: unknown[] = [];
  const agent = makeAgent(
    [
      { role: "user", content: "do the task" },
      { role: "assistant", content: "maybe done?" },
    ],
    steered,
  );
  await withFetch(["A"], async () => {
    let nextCalled = false;
    await handlers.get("agent/turn-stopping")?.({ agent }, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
  assert.equal(steered.length, 1);
  assert.match(
    JSON.stringify(steered[0]),
    /Verification score 0\.00 is below 0\.5/,
  );
});

test("turn-stopping does not steer when the score passes", async () => {
  const { ctx, handlers } = createCtx();
  apply(ctx, config);
  const steered: unknown[] = [];
  const agent = makeAgent(
    [
      { role: "user", content: "do the task" },
      { role: "assistant", content: "done and verified" },
    ],
    steered,
  );
  await withFetch(["T"], async () => {
    await handlers.get("agent/turn-stopping")?.({ agent }, () => undefined);
  });
  assert.equal(steered.length, 0);
});

test("turn-stopping is inert when the model router is present", async () => {
  const { ctx, handlers } = createCtx({ modelRouter: {} });
  apply(ctx, config);
  const steered: unknown[] = [];
  const agent = makeAgent(
    [
      { role: "user", content: "do the task" },
      { role: "assistant", content: "bad" },
    ],
    steered,
  );
  // No fetch stub needed: the handler must not reach scoring at all.
  let nextCalled = false;
  await handlers.get("agent/turn-stopping")?.({ agent }, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(steered.length, 0);
});

test("turn-stopping steers at most once per user message", async () => {
  const { ctx, handlers } = createCtx();
  apply(ctx, config);
  const steered: unknown[] = [];
  const messages = [
    { role: "user", content: "do the task" },
    { role: "assistant", content: "bad" },
  ];
  const agent = makeAgent(messages, steered);
  await withFetch(["A", "A", "A", "A"], async () => {
    await handlers.get("agent/turn-stopping")?.({ agent }, () => undefined);
    await handlers.get("agent/turn-stopping")?.({ agent }, () => undefined);
    // A new user message resets the once-per-message guard.
    messages.push(
      { role: "user", content: "next task" },
      { role: "assistant", content: "still bad" },
    );
    await handlers.get("agent/turn-stopping")?.({ agent }, () => undefined);
  });
  assert.equal(steered.length, 2);
});

test("turn-stopping skips silently when the model is not configured", async () => {
  const { ctx, handlers } = createCtx();
  apply(ctx); // default model is "" → not configured
  const agent = makeAgent(
    [
      { role: "user", content: "task" },
      { role: "assistant", content: "x" },
    ],
    [],
  );
  let nextCalled = false;
  await handlers.get("agent/turn-stopping")?.({ agent }, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
