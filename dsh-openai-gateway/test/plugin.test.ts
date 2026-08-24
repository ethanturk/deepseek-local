import assert from "node:assert/strict";
import test from "node:test";

import { inject, registerGatewayRoutes } from "../src/index.ts";

test("declares the router service dependency used for routing metadata", () => {
  assert.ok(inject.includes("modelRouter"));
});

test("registers exact OpenAI endpoints and a scoped v1 fallback", () => {
  const registrations: any[] = [];
  const effects: Array<() => void> = [];
  const ctx = {
    webServer: {
      register(route: any) {
        registrations.push(route);
        return () => undefined;
      },
    },
    effect(effect: () => void) {
      effects.push(effect);
      return effect();
    },
  };
  const routes = {
    models() {},
    chatCompletions() {},
    notFound() {},
  };

  registerGatewayRoutes(ctx, routes as any);

  assert.deepEqual(
    registrations.map(({ kind, path, handler }) => ({ kind, path, handler })),
    [
      { kind: "exact", path: "/v1/models", handler: routes.models },
      { kind: "exact", path: "/v1/chat/completions", handler: routes.chatCompletions },
      { kind: "exact", path: "/v1", handler: routes.notFound },
      { kind: "prefix", path: "/v1/", handler: routes.notFound },
    ],
  );
  assert.equal(effects.length, 4);
});
