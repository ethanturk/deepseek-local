import assert from "node:assert/strict";
import test from "node:test";

import type { VerifierBackend } from "../src/client.ts";
import {
  buildStepsFromMessages,
  scoreTrajectory,
} from "../src/verifier.ts";

const backend: VerifierBackend = {
  baseUrl: "http://verifier.test/v1",
  model: "verifier-model",
  topLogprobs: 20,
  maxTokens: 1024,
  timeoutMs: 5000,
};

function verifierResponse(letter: string, logprob = 0) {
  return new Response(
    JSON.stringify({
      choices: [{
        message: { content: `<c1>${letter}</c1>` },
        logprobs: {
          content: [
            { token: "<c1>", logprob: -0.1 },
            {
              token: letter,
              logprob,
              top_logprobs: [{ token: ` ${letter}`, logprob }],
            },
          ],
        },
      }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("scoreTrajectory averages the K repeats", async () => {
  const letters = ["T", "A", "T"];
  let calls = 0;
  const fetchImpl = async () => verifierResponse(letters[calls++ % letters.length]);
  const result = await scoreTrajectory(backend, "do the task", ["step one"], {
    nEvaluations: 3,
    fetchImpl,
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.perRep, [1, 0, 1]);
  assert.ok(Math.abs(result.score - 2 / 3) < 1e-9);
});

test("scoreTrajectory ignores repeats without a readable score", async () => {
  const bodies = ["no score here", "<c1>T</c1>"];
  let calls = 0;
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: bodies[calls++] } }],
      }),
      { status: 200 },
    );
  const result = await scoreTrajectory(backend, "p", ["s"], {
    nEvaluations: 2,
    fetchImpl,
  });
  assert.deepEqual(result.perRep, [undefined, 1]);
  assert.equal(result.score, 1);
});

test("scoreTrajectory tolerates rejected repeats", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error("backend unavailable");
    return verifierResponse("T");
  };
  const result = await scoreTrajectory(backend, "p", ["s"], {
    nEvaluations: 2,
    fetchImpl,
  });
  assert.equal(result.score, 1);
  assert.deepEqual(result.perRep, [undefined, 1]);
});

test("scoreTrajectory throws when every repeat rejects", async () => {
  const fetchImpl = async () => {
    throw new Error("backend down");
  };
  await assert.rejects(
    () =>
      scoreTrajectory(backend, "p", ["s"], { nEvaluations: 2, fetchImpl }),
    /verifier returned no readable score/,
  );
});

test("scoreTrajectory throws when every repeat is unreadable", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "???" } }] }),
      { status: 200 },
    );
  await assert.rejects(
    () =>
      scoreTrajectory(backend, "p", ["s"], { nEvaluations: 2, fetchImpl }),
    /verifier returned no readable score/,
  );
});

test("buildStepsFromMessages builds steps after the last real user message", () => {
  const messages = [
    { role: "user", content: "first task" },
    { role: "assistant", content: "stale reply" },
    {
      role: "user",
      content: "steered note",
      source: { kind: "plugin", id: "x" },
    },
    { role: "user", content: "do the real task" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Running the check." },
        { type: "tool_call", name: "bash", args: { cmd: "make test" } },
      ],
    },
    { role: "tool", content: "all tests pass" },
    { role: "assistant", content: "Done, verified." },
  ];
  const steps = buildStepsFromMessages(messages, 3, {
    maxStepChars: 2000,
    maxTrajectoryChars: 24000,
  });
  assert.equal(steps.length, 2);
  assert.match(steps[0], /Running the check\./);
  assert.match(steps[0], /\[tool_call bash\(\{"cmd":"make test"\}\)\]/);
  assert.match(steps[0], /\[tool_result\] all tests pass/);
  assert.equal(steps[1], "Done, verified.");
});

test("buildStepsFromMessages truncates steps and drops the oldest", () => {
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: "x".repeat(100) },
    { role: "assistant", content: "y".repeat(50) },
    { role: "assistant", content: "z".repeat(30) },
  ];
  const steps = buildStepsFromMessages(messages, 0, {
    maxStepChars: 60,
    maxTrajectoryChars: 120,
  });
  // first step truncated to 60 + marker, then oldest dropped until under budget
  assert.equal(steps[0], "[... earlier steps omitted ...]");
  const total = steps.join("").length;
  assert.ok(total <= 120 + steps[0].length);
  assert.ok(steps[steps.length - 1].startsWith("z".repeat(30)));
});

test("buildStepsFromMessages reads gateway tool-result messages", () => {
  const messages = [
    { role: "user", content: "task", source: { kind: "user" } },
    {
      role: "assistant",
      content: [
        { type: "tool_call", name: "bash", args: { cmd: "make test" } },
      ],
    },
    {
      role: "user",
      source: { kind: "tool", callId: "call-1" },
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "2 tests passed" }],
        isError: false,
      }],
    },
    {
      role: "user",
      source: { kind: "tool", callId: "call-2" },
      content: [{
        type: "tool-result",
        toolCallId: "call-2",
        content: [{ type: "text", text: "command failed" }],
        isError: true,
      }],
    },
    { role: "assistant", content: "Done." },
  ];
  const steps = buildStepsFromMessages(messages, 0, {
    maxStepChars: 2000,
    maxTrajectoryChars: 24000,
  });
  assert.equal(steps.length, 2);
  assert.match(steps[0], /\[tool_result\] 2 tests passed/);
  assert.match(steps[0], /\[tool_result:error\] command failed/);
  assert.equal(steps[1], "Done.");
});
