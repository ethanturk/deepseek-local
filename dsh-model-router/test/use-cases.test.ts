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

test("semantic rule IDs reject a trailing separator", () => {
  assert.throws(
    () => assertValidUseCases(
      { enabled: true, rules: [{ ...readOnlyRule, id: "read-" }] },
      { mode: "both", provider: "remote", model: "classifier" },
      ["fast", "medium", "smart"],
    ),
    /must be lowercase kebab-case/,
  );
});

test("semantic rules may omit negative examples", () => {
  assert.doesNotThrow(() => assertValidUseCases(
    { enabled: true, rules: [{ ...readOnlyRule, negativeExamples: [] }] },
    { mode: "both", provider: "remote", model: "classifier" },
    ["fast", "medium", "smart"],
  ));
});

for (const [name, rule, message] of [
  ["unknown tier", { ...readOnlyRule, tierId: "unknown" as never }, /unknown tier "unknown"/],
  ["empty description", { ...readOnlyRule, description: "" }, /description must not be empty/],
  ["whitespace description", { ...readOnlyRule, description: "  " }, /description must not be empty/],
  ["empty positive example", { ...readOnlyRule, positiveExamples: [""] }, /positive examples must not be empty/],
  ["whitespace positive example", { ...readOnlyRule, positiveExamples: ["  "] }, /positive examples must not be empty/],
  ["empty negative example", { ...readOnlyRule, negativeExamples: [""] }, /negative examples must not be empty/],
  ["whitespace negative example", { ...readOnlyRule, negativeExamples: ["  "] }, /negative examples must not be empty/],
] as const) {
  test(`semantic validation rejects ${name}`, () => {
    assert.throws(
      () => assertValidUseCases(
        { enabled: true, rules: [rule] },
        { mode: "both", provider: "remote", model: "classifier" },
        ["fast", "medium", "smart"],
      ),
      message,
    );
  });
}

for (const [name, classifier] of [
  ["missing provider", { mode: "llm", model: "classifier" }],
  ["blank provider", { mode: "both", provider: "  ", model: "classifier" }],
  ["missing model", { mode: "llm", provider: "remote" }],
  ["blank model", { mode: "both", provider: "remote", model: "  " }],
] as const) {
  test(`active semantic rules reject ${name}`, () => {
    assert.throws(
      () => assertValidUseCases(
        enabledUseCases,
        classifier,
        ["fast", "medium", "smart"],
      ),
      /with a provider and model/,
    );
  });
}

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

test("overlapping rules require the first configured match", () => {
  const prompt = buildClassifierPrompt(
    "Read src/index.ts",
    "user: Read src/index.ts",
    {
      enabled: true,
      rules: [
        readOnlyRule,
        {
          ...readOnlyRule,
          id: "retrieve",
          tierId: "medium",
          description: "Retrieve existing information.",
        },
      ],
    },
  );

  assert.match(prompt, /first configured matching rule/i);
  assert.ok(prompt.indexOf("use-case:read-only") < prompt.indexOf("use-case:retrieve"));
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
  assert.equal(
    parseClassifierDecision("use-case:read-only", { enabled: false, rules: [readOnlyRule] }),
    null,
  );
});

test("explicit stronger tier requests are detected before use-case routing", () => {
  assert.equal(explicitStrongerTier("Use the smart model to read PR 81522"), "smart");
  assert.equal(explicitStrongerTier("Route this file read to medium tier"), "medium");
  assert.equal(explicitStrongerTier("Don't use smart model"), null);
  assert.equal(explicitStrongerTier("Don't ever use smart model"), null);
  assert.equal(explicitStrongerTier("Don't escalate"), null);
  assert.equal(explicitStrongerTier("Use medium, not smart"), "medium");
  assert.equal(explicitStrongerTier("Don't use smart; use medium"), "medium");
  assert.equal(explicitStrongerTier("escalate"), "medium");
  assert.equal(explicitStrongerTier("Show ADO PR 81522 details"), null);
});

for (const request of [
  "Use anything but smart",
  "Use everything except smart tier",
  "Use any model other than smart",
  "Route this to anything but medium",
  "Choose any tier except medium",
  "Run this on a model other than medium",
]) {
  test(`excluded tier is not affirmative intent: ${request}`, () => {
    assert.equal(explicitStrongerTier(request), null);
  });
}

test("affirmative tier intent still wins when another tier is excluded", () => {
  assert.equal(explicitStrongerTier("Use smart, not medium"), "smart");
  assert.equal(explicitStrongerTier("Use anything but smart; use medium"), "medium");
});
