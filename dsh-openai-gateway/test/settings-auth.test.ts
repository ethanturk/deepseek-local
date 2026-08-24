import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GATEWAY_CONFIG,
  authenticateBearer,
  resolveApiKeys,
  resolveConfig,
} from "../src/settings.ts";

test("settings default to an isolated auto-tier gateway", () => {
  assert.deepEqual(resolveConfig({}), DEFAULT_GATEWAY_CONFIG);
});

test("settings reject unsafe or unsupported values", () => {
  assert.throws(() => resolveConfig({ model: "other" } as any), /auto-tier/);
  assert.throws(() => resolveConfig({ toolPolicy: "open" } as any), /toolPolicy/);
  assert.throws(() => resolveConfig({ maxConcurrentRequests: 0 }), /positive/);
  assert.throws(() => resolveConfig({ apiKeyEnvs: ["KEY", "KEY"] }), /unique/);
  assert.throws(() => resolveConfig({ corsOrigins: ["*"] }), /exact origin/);
});

test("API keys come from every configured environment variable", () => {
  const config = resolveConfig({ apiKeyEnvs: ["KEY_ONE", "KEY_TWO", "EMPTY"] });
  assert.deepEqual(resolveApiKeys(config, {
    KEY_ONE: "alpha",
    KEY_TWO: "beta",
    EMPTY: "",
  }), ["alpha", "beta"]);
});

test("Bearer authentication accepts any configured key and rejects other schemes", () => {
  const keys = ["alpha", "a-longer-secret"];
  assert.equal(authenticateBearer("Bearer alpha", keys), true);
  assert.equal(authenticateBearer("Bearer a-longer-secret", keys), true);
  assert.equal(authenticateBearer("Bearer wrong", keys), false);
  assert.equal(authenticateBearer("Basic alpha", keys), false);
  assert.equal(authenticateBearer(undefined, keys), false);
});
