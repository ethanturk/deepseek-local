import { OpenAiError } from "./errors.ts";
import type { OpenAiFunctionTool } from "./messages.ts";
import type { ToolPolicy } from "./settings.ts";

export interface ClientToolBridge {
  readonly executedClientCallIds: string[];
  error?: OpenAiError;
}

interface ToolContext {
  agent?: { session?: { deriveMessages?(): any[] } };
  tools: {
    schemas(scope?: unknown): Array<{ name: string }>;
    register(definition: any): () => void;
    restrict(filter: { deny: readonly string[] }): () => void;
    guard(guard: (execution: any) => string | undefined): () => void;
  };
}

function lastAssistantToolNames(agentCtx: ToolContext): string[] {
  const messages = agentCtx.agent?.session?.deriveMessages?.() ?? [];
  const assistant = messages.findLast((message: any) => message?.role === "assistant");
  if (!Array.isArray(assistant?.content)) return [];
  return assistant.content
    .filter((block: any) => block?.type === "tool-call")
    .map((block: any) => String(block.name));
}

export function installRequestTools(
  globalCtx: ToolContext,
  agentCtx: ToolContext,
  clientTools: readonly OpenAiFunctionTool[],
  policy: ToolPolicy,
  toolChoice: "auto" | "none",
): ClientToolBridge {
  const bridge: ClientToolBridge = { executedClientCallIds: [] };
  const globalNames = globalCtx.tools.schemas(agentCtx.agent).map((schema) => schema.name);

  if ((policy === "isolated" || toolChoice === "none") && globalNames.length > 0) {
    agentCtx.tools.restrict({ deny: globalNames });
  }
  if (toolChoice === "none") return bridge;

  const clientNames = new Set(clientTools.map((tool) => tool.name));
  const installedNames = new Set(globalNames.filter((name) => !clientNames.has(name)));

  if (policy === "permissive" && clientNames.size > 0 && installedNames.size > 0) {
    agentCtx.tools.guard(() => {
      const names = lastAssistantToolNames(agentCtx);
      const hasClient = names.some((name) => clientNames.has(name));
      const hasInstalled = names.some((name) => installedNames.has(name));
      if (!hasClient || !hasInstalled) return undefined;
      bridge.error ??= new OpenAiError(
        502,
        "api_error",
        "mixed_tool_ownership",
        "A single assistant response mixed client-owned and DSH-owned tool calls",
      );
      return "mixed tool ownership is not allowed";
    });
  }

  for (const tool of clientTools) {
    agentCtx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: {
          type: "object",
          properties: { captured: { type: "boolean" } },
          required: ["captured"],
          additionalProperties: false,
        },
        render: () => [{ type: "text", text: "Tool call returned to the API client." }],
      },
      async execute(_args: unknown, exec: { callId: unknown; concludeTurn(): void }) {
        bridge.executedClientCallIds.push(String(exec.callId));
        exec.concludeTurn();
        return { captured: true };
      },
    });
  }

  return bridge;
}
