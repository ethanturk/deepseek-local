/**
 * Verifier prompt construction — port of llm_verifier/progress.py
 * (`format_steps`, `build_progress_prompt`, no images) plus an optional
 * evaluation-criteria block.
 */

export interface VerifierCriterion {
  name: string;
  description: string;
}

/** Number the agent steps the way the checkpoint prompt refers to them. */
export function formatSteps(steps: string[]): string {
  const parts: string[] = [];
  steps.forEach((step, k) => {
    parts.push(`=== Agent Step ${k + 1} ===`);
    parts.push(String(step).trim());
    parts.push("");
  });
  return parts.join("\n");
}

/**
 * Neutral progress-scoring prompt. It never reveals whether the
 * trajectory eventually succeeded — successes and failures see the same
 * template.
 */
export function buildTurnPrompt(
  problem: string,
  trajectoryText: string,
  nSteps: number,
  checkpointSteps: number[],
  criteria?: VerifierCriterion[],
): string {
  const n = checkpointSteps.length;
  const out: string[] = [
    "You are a strict, skeptical evaluator of agent task attempts. " +
      "Agents routinely declare victory while their environment still " +
      "shows errors, edit the wrong target, or never actually run the " +
      "verification the task asks for. Trust observed output — NOT the " +
      "agent's narration.",
    "",
    "**Task instruction:**",
    problem.trim(),
    "",
    `**Agent trajectory (${nSteps} agent steps; each step is one ` +
      "action by the agent, with its observed output):**",
    trajectoryText,
    "",
    `You will score the trajectory at ${n} CHECKPOINTS. The score ` +
      "measures exactly ONE thing:",
    "",
    "    \"Given everything the agent has done up to and including " +
      "this step, would the agent's CURRENT state actually satisfy the " +
      "task's hidden grader (i.e. produce the expected files / output / " +
      "behavior the task requires)?\"",
    "",
    "Use the 20-letter A..T scale:",
    "  A = certainly NO — nothing useful done yet, or the agent is " +
      "going down a clearly wrong path.",
    "  B-G = leans NO — partial work exists but key pieces are missing " +
      "or broken.",
    "  H-M = uncertain — a plausible solution is taking shape, but no " +
      "convincing verification yet.",
    "  N-S = leans YES — the right artifacts appear to be in place and " +
      "partial verification has worked, with minor concerns.",
    "  T = essentially certain YES — the agent has run the relevant " +
      "verification and the observed output literally matches what the " +
      "task calls for, with no outstanding errors.",
    "",
    "CRITICAL CALIBRATION RULES:",
    "  * Effort, exploration, step count, and confident-sounding " +
      "narration are NOT progress. An agent that ran 20 commands and " +
      "still has not produced the right output deserves a score near A.",
    "  * Default to skepticism. The hidden grader is NOT visible to " +
      "you. A result with no real verification step should not exceed " +
      "~K, and even a verified-looking one should rarely exceed ~R " +
      "unless the verification clearly matches the task's stated " +
      "success criterion.",
    "  * Treat the agent's prose declarations (\"done!\", \"all tests " +
      "pass\") as ZERO evidence. Ground your score in the actual actions " +
      "and the actual output you can see.",
    "",
  ];
  if (criteria && criteria.length > 0) {
    out.push("**Evaluation criteria:**");
    for (const criterion of criteria) {
      out.push(`- ${criterion.name}: ${criterion.description}`);
    }
    out.push(
      "The score at each checkpoint must reflect ALL listed criteria: " +
        "a checkpoint only earns a high letter when the current state " +
        "satisfies every criterion that is expected to hold by then.",
      "",
    );
  }
  out.push(
    "EXPECTED PATTERNS — successive checkpoints do NOT have to rise:",
    "  * On a trajectory that genuinely solves the task, scores " +
      "typically rise from A toward T.",
    "  * On a trajectory committed to a WRONG approach, scores should " +
      "PLATEAU once the wrong artifact is in place.",
    "  * If the agent regresses (breaks something that worked), scores " +
      "should DECREASE.",
    "",
    "The N checkpoints to score are:",
  );
  checkpointSteps.forEach((k, i) => {
    out.push(`  Checkpoint ${i + 1} = state right after Agent Step ${k}`);
  });
  out.push("");
  out.push(
    "Score each checkpoint INDEPENDENTLY based on the agent's current " +
      "best attempt at that point in the trajectory. Output EXACTLY N " +
      "lines and nothing else, in the format:",
  );
  for (let i = 1; i <= n; i++) {
    out.push(`<c${i}>LETTER</c${i}>`);
  }
  out.push("");
  out.push("where each LETTER is a single letter from A to T.");
  return out.join("\n");
}
