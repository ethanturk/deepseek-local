import assert from "node:assert/strict";
import test from "node:test";

import { installRequestTools } from "../src/tools.ts";

function harness(globalNames: string[], lastBlocks: any[] = []) {
  const registered: any[] = [];
  const restrictions: any[] = [];
  const guards: any[] = [];
  const agent = {
    session: {
      deriveMessages: () => [{ role: "assistant", content: lastBlocks }],
    },
  };
  return {
    agent,
    registered,
    restrictions,
    guards,
    globalCtx: { tools: { schemas: () => globalNames.map((name) => ({ name })) } },
    agentCtx: {
      agent,
      tools: {
        register(definition: any) { registered.push(definition); return () => {}; },
        restrict(filter: any) { restrictions.push(filter); return () => {}; },
        guard(guard: any) { guards.push(guard); return () => {}; },
      },
    },
  };
}

const clientTool = {
  name: "get_weather",
  description: "Get weather",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

test("isolated policy hides installed tools and exposes client tools", () => {
  const h = harness(["bash", "read_file"]);
  installRequestTools(h.globalCtx as any, h.agentCtx as any, [clientTool], "isolated", "auto");
  assert.deepEqual(h.restrictions, [{ deny: ["bash", "read_file"] }]);
  assert.deepEqual(h.registered.map((tool) => tool.name), ["get_weather"]);
});

test("tool_choice none hides all tools under either policy", () => {
  for (const policy of ["isolated", "permissive"] as const) {
    const h = harness(["bash"]);
    installRequestTools(h.globalCtx as any, h.agentCtx as any, [clientTool], policy, "none");
    assert.deepEqual(h.restrictions, [{ deny: ["bash"] }]);
    assert.equal(h.registered.length, 0);
  }
});

test("client tool execution captures the call and concludes the turn", async () => {
  const h = harness([]);
  const bridge = installRequestTools(h.globalCtx as any, h.agentCtx as any, [clientTool], "isolated", "auto");
  let concluded = 0;
  const result = await h.registered[0].execute({ city: "Chicago" }, {
    callId: "call_1",
    concludeTurn() { concluded += 1; },
  });
  assert.deepEqual(result, { captured: true });
  assert.equal(concluded, 1);
  assert.deepEqual(bridge.executedClientCallIds, ["call_1"]);
});

test("permissive mixed ownership is blocked before dispatch", () => {
  const h = harness(["bash"], [
    { type: "tool-call", id: "one", name: "get_weather", arguments: "{}" },
    { type: "tool-call", id: "two", name: "bash", arguments: "{}" },
  ]);
  const bridge = installRequestTools(h.globalCtx as any, h.agentCtx as any, [clientTool], "permissive", "auto");
  const reason = h.guards[0]({ name: "bash" });
  assert.match(reason, /mixed tool ownership/);
  assert.equal(bridge.error?.code, "mixed_tool_ownership");
});

test("scoped client tools shadow installed tools with the same name", () => {
  const h = harness(["get_weather", "bash"]);
  installRequestTools(h.globalCtx as any, h.agentCtx as any, [clientTool], "permissive", "auto");
  assert.equal(h.restrictions.length, 0);
  assert.deepEqual(h.registered.map((tool) => tool.name), ["get_weather"]);
});
