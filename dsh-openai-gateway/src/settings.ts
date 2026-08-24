import { createHash, timingSafeEqual } from "node:crypto";

export type ToolPolicy = "isolated" | "permissive";

export interface GatewayConfig {
  model: "auto-tier";
  apiKeyEnvs: string[];
  toolPolicy: ToolPolicy;
  maxRequestBodyBytes: number;
  requestTimeoutMs: number;
  maxConcurrentRequests: number;
  corsOrigins: string[];
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = Object.freeze({
  model: "auto-tier",
  apiKeyEnvs: Object.freeze(["DSH_OPENAI_API_KEY"]) as unknown as string[],
  toolPolicy: "isolated",
  maxRequestBodyBytes: 4_194_304,
  requestTimeoutMs: 600_000,
  maxConcurrentRequests: 2,
  corsOrigins: Object.freeze([]) as unknown as string[],
});

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError(`${name} must contain nonempty strings`);
  }
  return [...value];
}

export function resolveConfig(raw: Partial<GatewayConfig>): GatewayConfig {
  const model = raw.model ?? DEFAULT_GATEWAY_CONFIG.model;
  if (model !== "auto-tier") throw new TypeError("model must be auto-tier");

  const toolPolicy = raw.toolPolicy ?? DEFAULT_GATEWAY_CONFIG.toolPolicy;
  if (toolPolicy !== "isolated" && toolPolicy !== "permissive") {
    throw new TypeError("toolPolicy must be isolated or permissive");
  }

  const apiKeyEnvs = stringArray(
    raw.apiKeyEnvs ?? DEFAULT_GATEWAY_CONFIG.apiKeyEnvs,
    "apiKeyEnvs",
  );
  if (new Set(apiKeyEnvs).size !== apiKeyEnvs.length) {
    throw new TypeError("apiKeyEnvs must be unique");
  }

  const corsOrigins = stringArray(
    raw.corsOrigins ?? DEFAULT_GATEWAY_CONFIG.corsOrigins,
    "corsOrigins",
  );
  for (const origin of corsOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError("corsOrigins must contain an exact origin");
    }
    if (origin === "*" || parsed.origin !== origin || !/^https?:$/.test(parsed.protocol)) {
      throw new TypeError("corsOrigins must contain an exact origin");
    }
  }

  return {
    model,
    apiKeyEnvs,
    toolPolicy,
    maxRequestBodyBytes: positiveSafeInteger(
      raw.maxRequestBodyBytes ?? DEFAULT_GATEWAY_CONFIG.maxRequestBodyBytes,
      "maxRequestBodyBytes",
    ),
    requestTimeoutMs: positiveSafeInteger(
      raw.requestTimeoutMs ?? DEFAULT_GATEWAY_CONFIG.requestTimeoutMs,
      "requestTimeoutMs",
    ),
    maxConcurrentRequests: positiveSafeInteger(
      raw.maxConcurrentRequests ?? DEFAULT_GATEWAY_CONFIG.maxConcurrentRequests,
      "maxConcurrentRequests",
    ),
    corsOrigins,
  };
}

export function resolveApiKeys(
  config: GatewayConfig,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return config.apiKeyEnvs.flatMap((name) => {
    const value = env[name];
    return value ? [value] : [];
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function authenticateBearer(
  authorization: string | undefined,
  apiKeys: readonly string[],
): boolean {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const candidate = digest(match?.[1] ?? "");
  let accepted = false;
  for (const key of apiKeys) {
    accepted = timingSafeEqual(candidate, digest(key)) || accepted;
  }
  return match !== null && apiKeys.length > 0 && accepted;
}
