/**
 * dsh-local-model-guard – shared types
 * Strict monitoring for flaky local models in DeepSeek Harness.
 */

export interface LocalGuardConfig {
  /** Max consecutive tool failures before intervention. Default 3. */
  maxConsecutiveFailures: number;

  /** Max times the same tool+args signature may repeat in the window. Default 2. */
  maxRepeatedCalls: number;

  /** Sliding window size for recent tool signatures. Default 8. */
  windowSize: number;

  /** Enable limited retries on tool execute for flaky local models. Default true. */
  enableRetries: boolean;

  /** Max retries per tool call (0 or 1 recommended). Default 1. */
  maxRetries: number;

  /** When true, also apply a short system-prompt section. Default true. */
  enableSystemPromptHint: boolean;

  /**
   * If true, always enforce guards regardless of modelRouter.
   * If false (default), only enforce when modelRouter says enableLocalGuardrails
   * for the current tier, or when modelRouter is absent.
   */
  forceAlways: boolean;

  /** Short recovery message injected when thresholds are hit (keep tiny). */
  recoveryMessage: string;
}

export interface GuardState {
  consecutiveFailures: number;
  recentSignatures: string[];
  /** Number of ask_user_question calls attempted in the current model step. */
  askCallsThisStep: number;
  lastInterventionAt?: number;
  /** One corrected ask instruction after invalid or duplicate ask calls. */
  pendingAskRetry?: string;
  /** Prevent repeated empty-response recovery within one turn. */
  emptyResponseRecoveryAttempted?: boolean;
  /** One controlled retry instruction after an opaque subagent runtime failure. */
  pendingSubagentRetry?: string;
  /** Optional recent tool failure count for heuristic context. */
  recentToolFailures: number;
}

/**
 * Tuned for flaky local / small models:
 * - Intervene after 2 consecutive failures (sooner than a cloud model would need)
 * - Break loops at 2 identical tool+args calls
 * - Shorter window keeps memory and false-positives down
 * - Recovery text stays under ~40 tokens so context stays small
 */
export const DEFAULT_GUARD_CONFIG: LocalGuardConfig = {
  maxConsecutiveFailures: 2,
  maxRepeatedCalls: 2,
  windowSize: 6,
  enableRetries: true,
  maxRetries: 1,
  enableSystemPromptHint: true,
  forceAlways: false,
  recoveryMessage:
    "Tool calls failed or repeated. Do not retry the same call. State the error in one sentence, then try a different approach.",
};
