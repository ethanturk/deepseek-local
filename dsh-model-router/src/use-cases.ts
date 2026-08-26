import type { ClassifierConfig, TierId, UseCasesConfig } from "./types.ts";

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
