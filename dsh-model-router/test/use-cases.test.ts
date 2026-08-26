import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/types.ts";
import {
  assertValidUseCases,
  buildClassifierPrompt,
  explicitStrongerTier,
  parseClassifierDecision,
} from "../src/use-cases.ts";

const readOnlyRule = {
  id: "read-only",
  tierId: "fast" as const,
  description: "Retrieve existing information without analysis or mutation.",
  positiveExamples: [
    "Read src/index.ts",
    "Show ADO PR 81522 details",
    "I'll paginate through the threads",
  ],
  negativeExamples: ["Review PR 81522", "Modify src/index.ts"],
};

test("semantic use cases are disabled by default", () => {
  assert.deepEqual(DEFAULT_CONFIG.useCases, { enabled: false, rules: [] });
});

test("active semantic rules require an LLM classifier", () => {
  assert.throws(
    () => assertValidUseCases(
      { enabled: true, rules: [readOnlyRule] },
      { mode: "heuristic" },
      ["fast", "medium", "smart"],
    ),
    /semantic use cases require classifier mode "llm" or "both"/,
  );
});

test("enabled with no semantic rules remains a no-op", () => {
  assert.doesNotThrow(() => assertValidUseCases(
    { enabled: true, rules: [] },
    { mode: "heuristic" },
    ["fast", "medium", "smart"],
  ));
});

test("semantic rule ids and content are validated", () => {
  assert.throws(
    () => assertValidUseCases(
      { enabled: true, rules: [readOnlyRule, { ...readOnlyRule }] },
      { mode: "both", provider: "remote", model: "classifier" },
      ["fast", "medium", "smart"],
    ),
    /duplicate semantic use-case id "read-only"/,
  );
  assert.throws(
    () => assertValidUseCases(
      { enabled: true, rules: [{ ...readOnlyRule, positiveExamples: [] }] },
      { mode: "both", provider: "remote", model: "classifier" },
      ["fast", "medium", "smart"],
    ),
    /at least one positive example/,
  );
});

const enabledUseCases = { enabled: true, rules: [readOnlyRule] };

test("active rules are embedded in the existing classifier prompt", () => {
  const prompt = buildClassifierPrompt(
    "Show ADO PR 81522 details",
    "user: Show ADO PR 81522 details",
    enabledUseCases,
  );
  assert.match(prompt, /use-case:read-only/);
  assert.match(prompt, /I'll paginate through the threads/);
  assert.match(prompt, /Review PR 81522/);
  assert.match(prompt, /entire current request/);
});

test("disabled rules preserve the legacy prompt contract", () => {
  const prompt = buildClassifierPrompt(
    "Refactor authentication",
    "user: Refactor authentication",
    { enabled: false, rules: [readOnlyRule] },
  );
  assert.match(prompt, /Reply with exactly one word: simple, medium, or hard\./);
  assert.doesNotMatch(prompt, /use-case:/);
});

test("only exact configured use-case responses are accepted", () => {
  assert.deepEqual(
    parseClassifierDecision("use-case:read-only", enabledUseCases),
    { kind: "use-case", useCaseId: "read-only", tierId: "fast" },
  );
  assert.equal(
    parseClassifierDecision("use-case:unknown", enabledUseCases),
    null,
  );
  assert.equal(
    parseClassifierDecision("use-case:read-only because it is easy", enabledUseCases),
    null,
  );
});

test("explicit stronger tier requests are detected before use-case routing", () => {
  assert.equal(explicitStrongerTier("Use the smart model to read PR 81522"), "smart");
  assert.equal(explicitStrongerTier("Route this file read to medium tier"), "medium");
  assert.equal(explicitStrongerTier("Show ADO PR 81522 details"), null);
});
