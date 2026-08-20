/**
 * dsh-model-router – shared types
 * DeepSeek Harness developer-preview plugin
 */

export type TierId = "fast" | "medium" | "smart";
export type Complexity = "simple" | "medium" | "hard";
export type StickyScope = "turn" | "session";
export type ClassifierMode = "llm" | "heuristic" | "both";

/**
 * Reasoning effort is adapter-owned (opaque id).
 * Common values depend on the provider, e.g. "off" | "low" | "medium" | "high" | "max".
 * Omit to use the model's provider default.
 */
export type ReasoningEffortId = string;

export interface TierConfig {
  id: TierId;
  provider: string;
  model: string;
  /** When true, the companion local-model-guard applies strict monitoring. Default false. */
  enableLocalGuardrails: boolean;
  /**
   * Optional reasoning effort for this tier.
   * Passed through ModelSelection / GenerateOptions when the seam supports it.
   * Example: "off" | "low" | "high" | "max"
   */
  reasoningEffort?: ReasoningEffortId;
}

export interface ClassifierConfig {
  /** "heuristic" | "llm" | "both" (heuristic first, LLM fallback). */
  mode: ClassifierMode;
  provider?: string;
  model?: string;
}

export interface ValidatorConfig {
  /** Always the smartest tier for validation. */
  alwaysUseTierId: TierId;
  maxEscalations: number;
  /** Default "turn". */
  stickyScope: StickyScope;
}

export interface VirtualModelConfig {
  id: string;
  displayName: string;
}

export interface ModelRouterConfig {
  tiers: [TierConfig, TierConfig, TierConfig]; // ordered fast → medium → smart
  classifier: ClassifierConfig;
  validator: ValidatorConfig;
  virtualModel: VirtualModelConfig;
  enableSystemPromptHint: boolean;
}

export interface RouterState {
  currentTierId: TierId;
  escalationCount: number;
  lastClassification: Complexity | null;
  lastValidation: { passed: boolean; reason?: string } | null;
  stickyUntil: "end-of-turn" | "end-of-session" | null;
  /** When true, the next step must re-generate the previous assistant response on a higher tier. */
  pendingRegenerate: boolean;
  /** Original user message that triggered the current turn (for re-generation). */
  lastUserMessage?: string;
  /**
   * When reasoningEffort caused a request failure, we strip it for this agent
   * (and optionally the tier) so subsequent requests succeed.
   */
  reasoningEffortDisabled?: boolean;
  lastReasoningEffortError?: string;
}

export interface ModelRouterService {
  getCurrentTier(agentId: string): TierId | undefined;
  getTierConfig(tierId: TierId): TierConfig | undefined;
  isLocalGuardrailsEnabled(agentId: string): boolean;
  forceTier(agentId: string, tierId: TierId): void;
  getState(agentId: string): RouterState | undefined;
}

/** Local-only composition fallback; DSH settings own the live tier assignments. */
export const DEFAULT_CONFIG: ModelRouterConfig = {
  tiers: [
    {
      id: "fast",
      provider: "local",
      model: "qwen2.5:7b",
      enableLocalGuardrails: true,
    },
    {
      id: "medium",
      provider: "local",
      model: "qwen2.5:7b",
      enableLocalGuardrails: true,
    },
    {
      id: "smart",
      provider: "local",
      model: "qwen2.5:7b",
      enableLocalGuardrails: true,
    },
  ],
  classifier: {
    mode: "both",
    provider: "local",
    model: "qwen2.5:7b",
  },
  validator: {
    alwaysUseTierId: "smart",
    maxEscalations: 2,
    stickyScope: "turn",
  },
  virtualModel: {
    id: "auto-tier",
    displayName: "Auto (Tiered Router)",
  },
  enableSystemPromptHint: true,
};
