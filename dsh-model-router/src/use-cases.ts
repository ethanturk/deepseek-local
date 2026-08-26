import type {
  ClassifierConfig,
  Complexity,
  TierId,
  UseCasesConfig,
} from "./types.ts";

export type ClassifierDecision =
  | { kind: "complexity"; complexity: Complexity }
  | { kind: "use-case"; useCaseId: string; tierId: TierId };

const USE_CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertTrimmed(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (value !== value.trim()) throw new Error(`${label} must be trimmed`);
}

export function assertValidUseCases(
  config: UseCasesConfig,
  classifier: ClassifierConfig,
  tierIds: readonly TierId[],
): void {
  const ids = new Set<string>();
  const configuredTiers = new Set(tierIds);

  for (const rule of config.rules) {
    if (!USE_CASE_ID.test(rule.id)) {
      throw new Error(`semantic use-case id "${rule.id}" must be lowercase kebab-case`);
    }
    if (ids.has(rule.id)) throw new Error(`duplicate semantic use-case id "${rule.id}"`);
    ids.add(rule.id);
    if (!configuredTiers.has(rule.tierId)) {
      throw new Error(`semantic use-case "${rule.id}" references unknown tier "${rule.tierId}"`);
    }
    assertTrimmed(rule.description, `semantic use-case "${rule.id}" description`);
    if (!rule.positiveExamples.length) {
      throw new Error(`semantic use-case "${rule.id}" requires at least one positive example`);
    }
    if (!rule.negativeExamples.length) {
      throw new Error(`semantic use-case "${rule.id}" requires at least one negative example`);
    }
    rule.positiveExamples.forEach((example) => {
      assertTrimmed(example, `semantic use-case "${rule.id}" positive examples`);
    });
    rule.negativeExamples.forEach((example) => {
      assertTrimmed(example, `semantic use-case "${rule.id}" negative examples`);
    });
  }

  if (
    config.enabled && config.rules.length > 0 &&
    (classifier.mode === "heuristic" || !classifier.provider?.trim() || !classifier.model?.trim())
  ) {
    throw new Error('semantic use cases require classifier mode "llm" or "both" with a provider and model');
  }
}

function legacyClassifierPrompt(message: string, conversation: string): string {
  return `Classify the difficulty of the current user request using the recent conversation for context.
Reply with exactly one word: simple, medium, or hard.

Recent conversation:
${conversation.slice(-3000)}

Current request:
${message.slice(0, 2000)}`;
}

export function buildClassifierPrompt(
  message: string,
  conversation: string,
  useCases: UseCasesConfig,
): string {
  if (!useCases.enabled || useCases.rules.length === 0) {
    return legacyClassifierPrompt(message, conversation);
  }

  const rules = useCases.rules.map((rule, index) => [
    `${index + 1}. use-case:${rule.id} (tier: ${rule.tierId})`,
    `Description: ${rule.description}`,
    `Positive examples: ${rule.positiveExamples.join(" | ")}`,
    `Negative examples: ${rule.negativeExamples.join(" | ")}`,
  ].join("\n")).join("\n\n");

  return `Classify the difficulty of the current user request using the recent conversation for context.
Reply with exactly one response line: use-case:<id>, simple, medium, or hard.
A use case applies only when the entire current request fits that use case. If uncertain or the request includes additional work, return a complexity label.

Ordered semantic use-case rules:
${rules}

Recent conversation:
${conversation.slice(-3000)}

Current request:
${message.slice(0, 2000)}`;
}

export function parseClassifierDecision(
  text: string,
  useCases: UseCasesConfig,
): ClassifierDecision | null {
  const response = text.trim().toLowerCase();
  if (response === "simple" || response === "medium" || response === "hard") {
    return { kind: "complexity", complexity: response };
  }

  const match = /^use-case:([a-z0-9][a-z0-9-]{0,63})$/.exec(response);
  if (!match) return null;
  if (!useCases.enabled) return null;
  const rule = useCases.rules.find(({ id }) => id === match[1]);
  return rule
    ? { kind: "use-case", useCaseId: rule.id, tierId: rule.tierId }
    : null;
}

export function explicitStrongerTier(message: string): "medium" | "smart" | null {
  const text = message.trim().toLowerCase();
  const intent = /\b(?:use|choose|force|route|switch|select|pick|send|move|run|set|escalat(?:e|ed|ing|ion))\b(?:\s+(?!(?:not|never|don't|dont|do)\b)[\w'-]+){0,8}\s+(smart|medium)(?:\s+(?:model|tier))?\b/g;
  let mediumRequested = false;
  for (const match of text.matchAll(intent)) {
    if (isNegatedAt(text, match.index ?? 0)) continue;
    if (match[1] === "smart") return "smart";
    mediumRequested = true;
  }
  if (mediumRequested) return "medium";
  for (const match of text.matchAll(/\bescalat(?:e|ed|ing|ion)\b/g)) {
    if (!isNegatedAt(text, match.index ?? 0)) return "medium";
  }
  return null;
}

function isNegatedAt(text: string, index: number): boolean {
  const clause = text.slice(0, index).split(/[;,.!?]|\b(?:and|but)\b/).at(-1) ?? "";
  return /\b(?:don't|dont|never|not)\b|\bdo\s+not\b/.test(clause);
}
