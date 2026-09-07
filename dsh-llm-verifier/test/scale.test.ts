import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedValueFromAlts,
  extractTagScores,
  letterValue,
} from "../src/scale.ts";

test("letterValue maps A..T to 0..1", () => {
  assert.equal(letterValue("A"), 0);
  assert.equal(letterValue("T"), 1);
  assert.equal(letterValue("K"), 10 / 19);
  assert.equal(letterValue("a"), 0);
  assert.equal(letterValue("t"), 1);
  assert.equal(letterValue("U"), undefined);
  assert.equal(letterValue(""), undefined);
});

test("expectedValueFromAlts softmaxes over letter values", () => {
  // Tokens with whitespace / fused ">" are decoded; non-letters ignored.
  const score = expectedValueFromAlts([
    { token: " T", logprob: 0 }, // p=1 -> value 1
    { token: ">A", logprob: 0 }, // p=1 -> value 0
    { token: "x", logprob: 5 }, // not a letter, ignored
  ]);
  assert.ok(score !== undefined);
  assert.ok(Math.abs(score - 0.5) < 1e-9);
});

test("expectedValueFromAlts keeps the max logprob per value", () => {
  const score = expectedValueFromAlts([
    { token: "B", logprob: -5 },
    { token: "B", logprob: 0 },
    { token: "T", logprob: -10 },
  ]);
  // ~ B/(B + tiny T) — dominated by B = 1/19.
  assert.ok(score !== undefined && score < 0.06 && score > 0.05);
});

test("expectedValueFromAlts handles fused '>B' tokens", () => {
  const score = expectedValueFromAlts([{ token: ">B", logprob: 0 }]);
  assert.equal(score, 1 / 19);
});

test("expectedValueFromAlts returns undefined without letters", () => {
  assert.equal(expectedValueFromAlts([{ token: "yes", logprob: 0 }]), undefined);
  assert.equal(expectedValueFromAlts([]), undefined);
  assert.equal(expectedValueFromAlts(undefined), undefined);
});

test("extractTagScores uses logprob expectation at the answer position", () => {
  const tokens = ["<c1>", "T", "</c1>"];
  const positionLogprobs = [
    [{ token: "<c1>", logprob: 0 }],
    [
      { token: " T", logprob: 0 },
      { token: " A", logprob: -2 },
    ],
    [{ token: "</c1>", logprob: 0 }],
  ];
  const scores = extractTagScores("", tokens, positionLogprobs, 1);
  const pA = Math.exp(-2) / (1 + Math.exp(-2));
  const expected = 1 * (1 / (1 + Math.exp(-2))) + 0 * pA;
  assert.ok(scores[0] !== undefined);
  assert.ok(Math.abs(scores[0]! - expected) < 1e-9);
});

test("extractTagScores falls back to the literal letter in the text", () => {
  const scores = extractTagScores("<c1>K</c1>", undefined, undefined, 1);
  assert.equal(scores[0], 10 / 19);
});

test("extractTagScores skips whitespace-only tokens after the tag", () => {
  const tokens = ["<c1>", " ", "S", "</c1>"];
  const positionLogprobs = [
    [{ token: "<c1>", logprob: 0 }],
    [{ token: " ", logprob: 0 }],
    [
      { token: " S", logprob: 0 },
      { token: " A", logprob: -20 },
    ],
    [{ token: "</c1>", logprob: 0 }],
  ];
  const scores = extractTagScores("", tokens, positionLogprobs, 1);
  assert.ok(scores[0] !== undefined);
  assert.ok(Math.abs(scores[0]! - 18 / 19) < 0.01); // S = 18/19 dominates
});

test("extractTagScores fills multiple tags independently", () => {
  const text = "<c1>A</c1>\n<c2>T</c2>";
  const scores = extractTagScores(text, undefined, undefined, 2);
  assert.equal(scores[0], 0);
  assert.equal(scores[1], 1);
});
