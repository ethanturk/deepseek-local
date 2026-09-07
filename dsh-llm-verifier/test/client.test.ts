import assert from "node:assert/strict";
import test from "node:test";

import { callVerifier, type VerifierBackend } from "../src/client.ts";

const backend: VerifierBackend = {
  baseUrl: "http://verifier.test/v1/",
  apiKey: "secret-key",
  model: "verifier-model",
  topLogprobs: 20,
  maxTokens: 1024,
  timeoutMs: 5000,
};

test("callVerifier posts a logprobs chat completion request", async () => {
  let seenUrl = "";
  let seenInit: any;
  const fetchImpl = async (url: any, init: any) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(
      JSON.stringify({
        choices: [{
          message: { content: "<c1>T</c1>" },
          logprobs: {
            content: [
              {
                token: "<c1>",
                logprob: -0.1,
                top_logprobs: [{ token: "<c1>", logprob: -0.1 }],
              },
              {
                token: "T",
                logprob: -0.2,
                top_logprobs: [
                  { token: " T", logprob: -0.2 },
                  { token: " A", logprob: -3 },
                ],
              },
            ],
          },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await callVerifier(backend, "the prompt", { fetchImpl });

  assert.equal(seenUrl, "http://verifier.test/v1/chat/completions");
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers.authorization, "Bearer secret-key");
  const body = JSON.parse(seenInit.body);
  assert.equal(body.model, "verifier-model");
  assert.equal(body.logprobs, true);
  assert.equal(body.top_logprobs, 20);
  assert.equal(body.temperature, 1.0);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "the prompt");

  assert.equal(result.text, "<c1>T</c1>");
  assert.deepEqual(result.tokens, ["<c1>", "T"]);
  assert.deepEqual(result.positionLogprobs?.[1], [
    { token: " T", logprob: -0.2 },
    { token: " A", logprob: -3 },
  ]);
});

test("callVerifier omits Authorization without an apiKey", async () => {
  let headers: any;
  const fetchImpl = async (_url: any, init: any) => {
    headers = init.headers;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    );
  };
  await callVerifier({ ...backend, apiKey: undefined }, "p", { fetchImpl });
  assert.equal(headers.authorization, undefined);
});

test("callVerifier falls back to the sampled token when top_logprobs absent", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        choices: [{
          message: { content: "K" },
          logprobs: { content: [{ token: "K", logprob: -0.5 }] },
        }],
      }),
      { status: 200 },
    );
  const result = await callVerifier(backend, "p", { fetchImpl });
  assert.deepEqual(result.positionLogprobs, [[{ token: "K", logprob: -0.5 }]]);
});

test("callVerifier throws on non-2xx with status and body", async () => {
  const fetchImpl = async () =>
    new Response("model not loaded", { status: 500, statusText: "Server Error" });
  await assert.rejects(
    () => callVerifier(backend, "p", { fetchImpl }),
    /HTTP 500 Server Error: model not loaded/,
  );
});
