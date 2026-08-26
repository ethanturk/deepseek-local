import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

import type { ClassifierConfig, UseCasesConfig } from "../src/types.ts";
import { assertValidUseCases } from "../src/use-cases.ts";

function yamlExample(markdown: string, marker: string): Record<string, any> {
  const markerIndex = markdown.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing documentation marker ${marker}`);
  const section = markdown.slice(markerIndex);
  const match = /```yaml\n([\s\S]*?)```/.exec(section);
  assert.ok(match, `missing YAML example after ${marker}`);
  return parse(match[1]);
}

for (const [name, url, marker] of [
  ["README", new URL("../README.md", import.meta.url), "This read-only rule is copyable"],
  ["INSTALL", new URL("../../INSTALL.md", import.meta.url), "This is an enabled, read-only example"],
] as const) {
  test(`${name} semantic use-case YAML parses and validates`, async () => {
    const markdown = await readFile(url, "utf8");
    const modelRouter = yamlExample(markdown, marker)["model-router"];
    const useCases = modelRouter.useCases as UseCasesConfig;
    const classifier = (modelRouter.classifier ?? {
      mode: "both",
      provider: "documented-provider",
      model: "documented-model",
    }) as ClassifierConfig;

    assertValidUseCases(
      { ...useCases, enabled: true },
      classifier,
      ["fast", "medium", "smart"],
    );
  });
}
