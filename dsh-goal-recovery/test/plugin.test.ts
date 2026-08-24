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
  const logLevels: string[] = [];
  const registeredEvents: string[] = [];
  let goal = options.goal ?? makeGoal();
  let goalReads = 0;
  let modelReads = 0;

  const record = (level: string) => (entry: unknown) => {
    logLevels.push(level);
    logs.push(entry);
  };
  const namedLogger = { debug: record("debug"), info: record("info"), warn: record("warn") };
  const logger = Object.assign(() => namedLogger, namedLogger);
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
      get: () => {
        goalReads += 1;
        return goal;
      },
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
    logLevels,
    registeredEvents,
    resumes,
    get goalReads() { return goalReads; },
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
  assert.equal(
    harness.asks[0]!.questions[0]!.detail,
    "DSH preserved the active goal but disabled automatic continuation when the session resumed.",
  );
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
    resume: () => { throw Object.assign(new Error("revision is stale"), { code: "GOAL_STALE_REVISION" }); },
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
    errorCode: "GOAL_STALE_REVISION",
    errorMessage: "revision is stale",
  }]);
});

test("fails closed without retry when resume rejects an invalid transition", async () => {
  const harness = makeContext({
    ask: async () => answer("Resume goal"),
    resume: () => { throw Object.assign(new Error("goal cannot resume"), { code: "GOAL_INVALID_TRANSITION" }); },
  });

  harness.emit("agent/session-start", makeAgent());
  await flush();

  assert.equal(harness.resumes.length, 1);
  assert.deepEqual(harness.logs, [{
    event: "goal-recovery/resume-failed",
    noticeKind: "resume-required",
    goalId: "goal-1",
    goalRevision: 3,
    roundsStarted: 2,
    maxGoalRounds: 8,
    errorCode: "GOAL_INVALID_TRANSITION",
    errorMessage: "goal cannot resume",
  }]);
});

test("does not inspect when the agent is disposed in the session-start tick", async () => {
  const harness = makeContext();
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  harness.emit("agent/disposed", agent);
  await flush();

  assert.equal(harness.goalReads, 0);
  assert.equal(harness.asks.length, 0);
});

test("does not inspect when the plugin is disposed in the session-start tick", async () => {
  const harness = makeContext();

  harness.emit("agent/session-start", makeAgent());
  harness.cleanups[0]!();
  await flush();

  assert.equal(harness.goalReads, 0);
  assert.equal(harness.asks.length, 0);
});

test("aborts pending question and ignores the disposed agent", async () => {
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
  assert.equal(asks.length, 1);
});

test("does not resume when an aborted question later resolves Resume goal", async () => {
  const gate = deferred<unknown>();
  const harness = makeContext({ ask: () => gate.promise });
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  await flush();
  harness.emit("agent/disposed", agent);
  gate.resolve(answer("Resume goal"));
  await flush();

  assert.equal(harness.resumes.length, 0);
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
  const gates = [deferred<unknown>(), deferred<unknown>()];
  const harness = makeContext({ ask: () => gates[harness.asks.length - 1]!.promise });
  const agent = makeAgent();

  harness.emit("agent/session-start", agent);
  await flush();
  harness.setGoal(makeGoal(4));
  harness.emit("agent/session-start", agent);
  await flush();

  assert.equal(harness.asks.length, 2);
  assert.notEqual(harness.asks[0]!.signal, harness.asks[1]!.signal);
  assert.equal(harness.asks[0]!.signal!.aborted, true);

  gates[0]!.resolve(answer("Leave paused"));
  await flush();
  harness.emit("agent/session-start", agent);
  await flush();
  assert.equal(harness.asks.length, 2);

  gates[1]!.resolve(answer("Leave paused"));
  await flush();
});

test("allows a later session resume when the terminal turn sequence changes", async () => {
  const gates = [deferred<unknown>(), deferred<unknown>()];
  const harness = makeContext({ ask: () => gates[harness.asks.length - 1]!.promise });
  const agent = makeAgent();
  const events = agent.session.events as unknown as Array<{
    type: "turn/end";
    seq: number;
    time: number;
    data: { turn: number; reason: { kind: "completed" } };
  }>;
  events.push({ type: "turn/end", seq: 3, time: 1, data: { turn: 1, reason: { kind: "completed" } } });

  harness.emit("agent/session-start", agent);
  await flush();
  events.push({ type: "turn/end", seq: 7, time: 2, data: { turn: 2, reason: { kind: "completed" } } });
  harness.emit("agent/session-start", agent);
  await flush();

  assert.equal(harness.asks.length, 2);
  assert.equal(harness.asks[0]!.signal!.aborted, true);
  gates[0]!.resolve(answer("Leave paused"));
  gates[1]!.resolve(answer("Leave paused"));
  await flush();
});

test("opens the round-limit notice when the live goal reaches its cap", async () => {
  const harness = makeContext({ goal: makeGoal(4, {
    phase: "blocked",
    roundsStarted: 4,
    maxGoalRounds: 4,
    blockedReason: { code: "round-limit", message: "Goal stopped after 4 rounds" },
  }) });
  const agent = makeAgent();

  harness.emit("goal/changed", agent);
  await flush();

  assert.equal(harness.asks.length, 1);
  assert.equal(harness.asks[0]!.questions[0]!.header, "Goal round limit");
  assert.equal(harness.asks[0]!.questions[0]!.question, "Goal stopped after 4/4 rounds.");
});

test("makes zero model calls and registers no model hooks", async () => {
  const harness = makeContext();
  harness.emit("agent/session-start", makeAgent());
  await flush();

  assert.equal(harness.modelReads, 0);
  assert.deepEqual(harness.registeredEvents, ["agent/session-start", "goal/changed", "agent/disposed"]);
});

test("logs ASK_ABORTED structurally below warning level", async () => {
  const harness = makeContext({ ask: async () => {
    throw Object.assign(new Error("safe ASK_ABORTED"), { code: "ASK_ABORTED", secret: "must not log" });
  } });

  harness.emit("agent/session-start", makeAgent());
  await flush();

  assert.equal(harness.resumes.length, 0);
  assert.deepEqual(harness.logLevels, ["debug"]);
  assert.deepEqual(harness.logs, [{
    event: "goal-recovery/question-failed",
    noticeKind: "resume-required",
    goalId: "goal-1",
    goalRevision: 3,
    roundsStarted: 2,
    maxGoalRounds: 8,
    errorCode: "ASK_ABORTED",
    errorMessage: "safe ASK_ABORTED",
  }]);
});

for (const code of ["CALLER_NOT_LIVE", "DELEGATED_CALLER", "NO_PROVIDER"]) {
  test(`warns for ${code} structurally without resuming or rejecting detached work`, async () => {
    const harness = makeContext({ ask: async () => {
      throw Object.assign(new Error(`safe ${code}`), { code, secret: "must not log" });
    } });

    harness.emit("agent/session-start", makeAgent());
    await flush();

    assert.equal(harness.resumes.length, 0);
    assert.deepEqual(harness.logLevels, ["warn"]);
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
