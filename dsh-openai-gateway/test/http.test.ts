import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createGatewayRoutes } from "../src/http.ts";
import { resolveConfig } from "../src/settings.ts";

async function serve(run: any, config = resolveConfig({}), logs: any[] = []) {
  const routes = createGatewayRoutes({
    getConfig: () => config,
    getApiKeys: () => ["secret"],
    run,
    log: (entry) => logs.push(entry),
  });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/v1/models") return routes.models(req, res);
    if (path === "/v1/chat/completions") return routes.chatCompletions(req, res);
    if (path === "/v1" || path.startsWith("/v1/")) return routes.notFound(req, res);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const accepted = {
  id: "chatcmpl-test",
  created: 123,
  model: "auto-tier",
  content: "hello",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 3, outputTokens: 2 },
  routing: { initialTier: "fast", finalTier: "fast", escalations: 0 },
};

test("models endpoint requires Bearer auth and advertises only auto-tier", async () => {
  const app = await serve(async () => accepted);
  try {
    const denied = await fetch(`${app.base}/v1/models`);
    assert.equal(denied.status, 401);
    const response = await fetch(`${app.base}/v1/models`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((model: any) => model.id), ["auto-tier"]);
  } finally {
    await app.close();
  }
});

test("chat completions validate content type and return OpenAI-shaped errors", async () => {
  const app = await serve(async () => accepted);
  try {
    const response = await fetch(`${app.base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(response.status, 400);
    const body: any = await response.json();
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(typeof body.error.code, "string");
  } finally {
    await app.close();
  }
});

test("successful chat completion includes usage, request id, and safe logs", async () => {
  const logs: any[] = [];
  const app = await serve(async () => accepted, resolveConfig({}), logs);
  try {
    const response = await fetch(`${app.base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto-tier",
        messages: [{ role: "user", content: "private prompt" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("x-request-id"));
    const body: any = await response.json();
    assert.equal(body.choices[0].message.content, "hello");
    assert.deepEqual(body.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    assert.equal(JSON.stringify(logs).includes("private prompt"), false);
    assert.equal(logs[0].finalTier, "fast");
  } finally {
    await app.close();
  }
});

test("concurrency limit rejects excess work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  const app = await serve(async () => { entered += 1; await gate; return accepted; }, resolveConfig({ maxConcurrentRequests: 1 }));
  const init = {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({ model: "auto-tier", messages: [{ role: "user", content: "x" }] }),
  };
  try {
    const first = fetch(`${app.base}/v1/chat/completions`, init);
    while (entered === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = await fetch(`${app.base}/v1/chat/completions`, init);
    assert.equal(second.status, 429);
    release();
    assert.equal((await first).status, 200);
  } finally {
    release();
    await app.close();
  }
});

test("CORS grants only exact configured origins", async () => {
  const app = await serve(async () => accepted, resolveConfig({ corsOrigins: ["https://client.example"] }));
  try {
    const allowed = await fetch(`${app.base}/v1/models`, {
      headers: { authorization: "Bearer secret", origin: "https://client.example" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://client.example");
    const denied = await fetch(`${app.base}/v1/models`, {
      headers: { authorization: "Bearer secret", origin: "https://evil.example" },
    });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  } finally {
    await app.close();
  }
});
