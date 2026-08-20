/**
 * Heuristic complexity classifier for dsh-model-router.
 * Hard keywords add +2 (user-adjusted).
 */

import type { Complexity } from "./types.ts";

export interface HeuristicContext {
  hasFiles?: boolean;
  recentToolFailures?: number;
}

const HARD_KEYWORDS = [
  "architecture",
  "design system",
  "refactor the whole",
  "migrate",
  "rewrite",
  "overhaul",
  "scalability",
  "performance bottleneck",
  "security audit",
  "threat model",
  "distributed",
  "concurrency",
  "race condition",
  "deadlock",
  "memory leak",
  "optimize the entire",
];

const MEDIUM_KEYWORDS = [
  "refactor",
  "redesign",
  "restructure",
  "improve",
  "optimize",
  "debug",
  "fix the bug",
  "investigate",
  "root cause",
  "add feature",
  "implement",
  "extend",
  "integrate",
  "unit test",
  "integration test",
  "e2e",
  "write tests",
];

const FILE_EXT_RE =
  /\b[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|java|cpp|h|css|json|yaml|yml|md)\b/g;

/**
 * Score-based heuristic.
 * ≤2 → simple, 3–5 → medium, ≥6 → hard
 */
export function classifyHeuristic(
  message: string,
  context?: HeuristicContext,
): Complexity {
  const text = message.toLowerCase().trim();
  let score = 0;

  // 1. Length
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 80) score += 2;
  else if (wordCount > 35) score += 1;

  // 2. Keywords (hard = +2)
  for (const kw of HARD_KEYWORDS) {
    if (text.includes(kw)) score += 2;
  }
  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw)) score += 1;
  }

  // 3. File mentions
  const fileMentions = (text.match(FILE_EXT_RE) || []).length;
  if (fileMentions >= 4) score += 3;
  else if (fileMentions >= 2) score += 2;
  else if (fileMentions === 1) score += 1;

  // 4. Multi-step language
  if (
    /\b(step by step|first .+ then|and then|after that|finally)\b/.test(text)
  ) {
    score += 1;
  }
  if (/\b(plan|outline|break down|decompose)\b/.test(text)) {
    score += 1;
  }

  // 5. Multiple questions
  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks >= 3) score += 2;
  else if (questionMarks === 2) score += 1;

  // 6. Context signals
  if (context?.recentToolFailures && context.recentToolFailures >= 2) {
    score += 2;
  }
  if (context?.hasFiles) score += 1;

  // 7. Trivial short requests
  if (wordCount < 8 && !text.includes("?") && fileMentions === 0) {
    score -= 2;
  }

  if (score <= 2) return "simple";
  if (score <= 5) return "medium";
  return "hard";
}

/** Borderline scores that should prefer LLM fallback when mode = "both". */
export function isBorderline(scoreOrComplexity: number | Complexity): boolean {
  if (typeof scoreOrComplexity === "string") {
    // We don't expose raw score; treat medium as potentially borderline for LLM.
    return scoreOrComplexity === "medium";
  }
  return scoreOrComplexity === 2 || scoreOrComplexity === 5;
}
