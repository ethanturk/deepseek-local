import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GoalRef, GoalView } from "@deepseek-ai/dsh-goal";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import plugin, { inject, name } from "../src/index.ts";

type Listener = (payload: { agent: Agent; source?: string }) => unknown;

const answer = (selected: string) => ({
  answers: [{ id: "goal-recovery", selected: [selected] }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function makeAgent(id = "agent-1"): Agent {
  return { id, session: { events: [] } } as unknown as Agent;
}

function makeGoal(revision = 3, overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: "goal-1" as GoalRef["id"],
    revision,
    objective: "ship it",
    phase: "active",
    roundsStarted: 2,
    maxGoalRounds: 8,
    createdAt: 1,
    updatedAt: 2,
    activation: "disarmed",
    ...overrides,
  };
}

function makeContext(options: {
  goal?: GoalView;
  ask?: (request: AskUserQuestionRequest) => Promise<unknown>;
  resume?: (agent: Agent, ref: GoalRef) => unknown;
} = {}) {
  const listeners = new Map<string, Listener[]>();
  const cleanups: Array<() => void> = [];
  const asks: AskUserQuestionRequest[] = [];
  const resumes: Array<{ agent: Agent; ref: GoalRef }> = [];
  const logs: unknown[] = [];
  const registeredEvents: string[] = [];
  let goal = options.goal ?? makeGoal();
  let modelReads = 0;

  const logger = Object.assign(
    () => ({ warn: (entry: unknown) => logs.push(entry) }),
    { warn: (entry: unknown) => logs.push(entry) },
  );
  const ctx = {
    on(event: string, listener: Listener) {
      registeredEvents.push(event);
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => true;
    },
    effect(run: () => () => void) {
      cleanups.push(run());
      return () => Promise.resolve();
    },
    goals: {
      get: () => goal,
      resume: (agent: Agent, ref: GoalRef) => {
        resumes.push({ agent, ref });
        return options.resume?.(agent, ref);
      },
    },
    userQuestions: {
      ask: (request: AskUserQuestionRequest) => {
        asks.push(request);
        return options.ask?.(request) ?? Promise.resolve(answer("Leave paused"));
      },
    },
    logger,
    get llm() {
      modelReads += 1;
      return undefined;
    },
  };

  plugin.apply(ctx as never);

  return {
    asks,
    cleanups,
    ctx,
    logs,
    registeredEvents,
    resumes,
    get modelReads() { return modelReads; },
    setGoal(value: GoalView) { goal = value; },
    emit(event: string, agent: Agent) {
      return (listeners.get(event) ?? []).map((listener) => listener({ agent, source: "resume" }));
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("exports the native plugin contract", () => {
  assert.equal(name, "dsh-goal-recovery");
  assert.deepEqual(inject, ["agents", "goals", "userQuestions"]);
});

test("defers inspection until after session-start listeners finish", async () => {
  const harness = makeContext({ goal: makeGoal(3, { activation: "armed" }) });
  const agent = makeAgent();
  harness.ctx.on("agent/session-start", () => harness.setGoal(makeGoal(4)));

  harness.emit("agent/session-start", agent);
  assert.equal(harness.asks.length, 0);
  await flush();

  assert.equal(harness.asks.length, 1);
  assert.match(harness.asks[0]!.questions[0]!.detail!, /2\/8/);
});

test("asks once for one exact agent and goal revision", async () => {
  const gate = deferred<unknown>();
  const harness = makeContext({ ask: () => gate.promise });
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  harness.emit("agent/session-start", agent);
  await flush();

  assert.equal(harness.asks.length, 1);
  assert.equal(harness.asks[0]!.agent, agent);
  gate.resolve(answer("Leave paused"));
  await flush();
});

test("does not block session-start publication on the pending answer", async () => {
  const gate = deferred<unknown>();
  const harness = makeContext({ ask: () => gate.promise });

  const returns = harness.emit("agent/session-start", makeAgent());
  assert.deepEqual(returns, [undefined]);
  await flush();
  assert.equal(harness.asks.length, 1);

  gate.resolve(answer("Leave paused"));
  await flush();
});

test("resumes only the captured GoalRef after Resume goal", async () => {
  const gate = deferred<unknown>();
  const harness = makeContext({ ask: () => gate.promise });
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  await flush();
  harness.setGoal(makeGoal(4));
  gate.resolve(answer("Resume goal"));
  await flush();

  assert.deepEqual(harness.resumes, [{ agent, ref: { id: "goal-1", revision: 3 } }]);
});

test("does not resume after Leave paused or Acknowledge", async () => {
  for (const [selected, goal] of [
    ["Leave paused", makeGoal()],
    ["Acknowledge", makeGoal(3, { phase: "blocked", blockedReason: { code: "round-limit", message: "done" } })],
  ] as const) {
    const harness = makeContext({ goal, ask: async () => answer(selected) });
    harness.emit("agent/session-start", makeAgent());
    await flush();
    assert.equal(harness.resumes.length, 0);
  }
});

test("does not retry with a fresh ref when resume rejects stale revision", async () => {
  const harness = makeContext({
    ask: async () => answer("Resume goal"),
    resume: () => { throw Object.assign(new Error("revision is stale"), { code: "STALE_REVISION" }); },
  });
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  await flush();

  assert.equal(harness.resumes.length, 1);
  assert.deepEqual(harness.resumes[0]!.ref, { id: "goal-1", revision: 3 });
  assert.deepEqual(harness.logs, [{
    event: "goal-recovery/resume-failed",
    noticeKind: "resume-required",
    goalId: "goal-1",
    goalRevision: 3,
    roundsStarted: 2,
    maxGoalRounds: 8,
    errorCode: "STALE_REVISION",
    errorMessage: "revision is stale",
  }]);
});

test("aborts and clears pending question when agent is disposed", async () => {
  const asks: AskUserQuestionRequest[] = [];
  const harness = makeContext({ ask: (request) => {
    asks.push(request);
    return new Promise((_, reject) => request.signal!.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { code: "ASK_ABORTED" }));
    }, { once: true }));
  } });
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  await flush();
  harness.emit("agent/disposed", agent);
  await flush();
  assert.equal(asks[0]!.signal!.aborted, true);

  harness.emit("agent/session-start", agent);
  await flush();
  assert.equal(asks.length, 2);
  harness.emit("agent/disposed", agent);
  await flush();
});

test("aborts every pending question when plugin scope is disposed", async () => {
  const gate = deferred<unknown>();
  const harness = makeContext({ ask: () => gate.promise });

  harness.emit("agent/session-start", makeAgent("agent-1"));
  harness.emit("agent/session-start", makeAgent("agent-2"));
  await flush();
  harness.cleanups[0]!();

  assert.equal(harness.asks.length, 2);
  assert.ok(harness.asks.every((request) => request.signal!.aborted));
  gate.resolve(answer("Leave paused"));
  await flush();
});

test("allows a new question when the goal revision changes", async () => {
  const gate = deferred<unknown>();
  const harness = makeContext({ ask: () => gate.promise });
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  await flush();
  harness.setGoal(makeGoal(4));
  harness.emit("agent/session-start", agent);
  await flush();

  assert.equal(harness.asks.length, 2);
  assert.notEqual(harness.asks[0]!.signal, harness.asks[1]!.signal);
  gate.resolve(answer("Leave paused"));
  await flush();
});

test("makes zero model calls and registers no model hooks", async () => {
  const harness = makeContext();
  harness.emit("agent/session-start", makeAgent());
  await flush();

  assert.equal(harness.modelReads, 0);
  assert.deepEqual(harness.registeredEvents, ["agent/session-start", "agent/disposed"]);
});

for (const code of ["ASK_ABORTED", "CALLER_NOT_LIVE", "DELEGATED_CALLER", "NO_PROVIDER"]) {
  test(`logs ${code} structurally without resuming or rejecting detached work`, async () => {
    const harness = makeContext({ ask: async () => {
      throw Object.assign(new Error(`safe ${code}`), { code, secret: "must not log" });
    } });

    harness.emit("agent/session-start", makeAgent());
    await flush();

    assert.equal(harness.resumes.length, 0);
    assert.deepEqual(harness.logs, [{
      event: "goal-recovery/question-failed",
      noticeKind: "resume-required",
      goalId: "goal-1",
      goalRevision: 3,
      roundsStarted: 2,
      maxGoalRounds: 8,
      errorCode: code,
      errorMessage: `safe ${code}`,
    }]);
  });
}
