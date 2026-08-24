import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-host-webserver";
import { SessionId } from "@deepseek-ai/dsh-session";
import {
  installSettingsSection,
  settingsNamespace,
} from "@deepseek-ai/dsh-settings";
import "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import { createGatewayRoutes } from "./http.ts";
import { createCompletionRunner } from "./runner.ts";
import {
  resolveApiKeys,
  resolveConfig,
  type GatewayConfig,
} from "./settings.ts";

export const name = "dsh-openai-gateway";
export const inject = [
  "webServer",
  "llm",
  "systemPrompt",
  "tools",
  "sessions",
  "agents",
  "settings",
  "modelRouter",
];

export const OPENAI_GATEWAY_SETTINGS_NAMESPACE = settingsNamespace("openai-gateway");

export const OPENAI_GATEWAY_SETTINGS_SCHEMA = z.object({
  model: z.const("auto-tier").required(),
  apiKeyEnvs: z.array(z.string()).required(),
  toolPolicy: z.union([z.const("isolated"), z.const("permissive")]).required(),
  maxRequestBodyBytes: z.number().required(),
  requestTimeoutMs: z.number().required(),
  maxConcurrentRequests: z.number().required(),
  corsOrigins: z.array(z.string()).required(),
});

type GatewayRoutes = ReturnType<typeof createGatewayRoutes>;

export function registerGatewayRoutes(ctx: any, routes: GatewayRoutes): void {
  const registrations = [
    { kind: "exact", path: "/v1/models", handler: routes.models },
    { kind: "exact", path: "/v1/chat/completions", handler: routes.chatCompletions },
    { kind: "exact", path: "/v1", handler: routes.notFound },
    { kind: "prefix", path: "/v1/", handler: routes.notFound },
  ] as const;
  for (const route of registrations) {
    ctx.effect(() => ctx.webServer.register(route));
  }
}

export function apply(ctx: Context, rawConfig?: Partial<GatewayConfig>): void {
  const compositionConfig = resolveConfig(rawConfig ?? {});
  let config = compositionConfig;
  let apiKeys = resolveApiKeys(config, process.env);
  let settingsSource = () => compositionConfig;

  installSettingsSection(
    ctx,
    OPENAI_GATEWAY_SETTINGS_NAMESPACE,
    OPENAI_GATEWAY_SETTINGS_SCHEMA as z<GatewayConfig>,
    compositionConfig,
    {
      setSource(source) {
        settingsSource = source;
      },
      onChange() {
        config = resolveConfig(settingsSource());
        apiKeys = resolveApiKeys(config, process.env);
      },
      validate(value) {
        resolveConfig(value);
      },
    },
  );

  const run = createCompletionRunner({
    ctx,
    sessionId: SessionId,
    installModelSelection,
  });
  const routes = createGatewayRoutes({
    getConfig: () => config,
    getApiKeys: () => apiKeys,
    run,
    log(entry) {
      console.error("[dsh-openai-gateway]", JSON.stringify(entry));
    },
  });
  registerGatewayRoutes(ctx, routes);

  if (apiKeys.length === 0) {
    console.warn(
      `[dsh-openai-gateway] no API keys resolved from ${config.apiKeyEnvs.join(", ")}; requests will fail closed`,
    );
  }
}

export default { name, inject, apply };
