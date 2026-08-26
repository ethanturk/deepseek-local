import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/types.ts";
import { assertValidUseCases } from "../src/use-cases.ts";

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
