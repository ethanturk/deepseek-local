import assert from "node:assert/strict";
import test from "node:test";

import { sseFrames } from "../src/streaming.ts";

const result = {
  id: "chatcmpl-stream",
  created: 123,
  model: "auto-tier" as const,
  content: "accepted text",
  toolCalls: [],
  finishReason: "stop" as const,
  usage: { inputTokens: 4, outputTokens: 2 },
  routing: { initialTier: "fast", finalTier: "medium", escalations: 1 },
};

test("buffered SSE emits only accepted output in standard order", () => {
  const frames = sseFrames(result, false);
  assert.match(frames[0], /"role":"assistant"/);
  assert.match(frames[1], /"content":"accepted text"/);
  assert.match(frames[2], /"finish_reason":"stop"/);
  assert.equal(frames.at(-1), "data: [DONE]\n\n");
  assert.equal(frames.join("").includes("rejected FAST candidate"), false);
});

test("tool calls retain ids, indexes, names, and raw arguments", () => {
  const frames = sseFrames({
    ...result,
    content: null,
    finishReason: "tool_calls",
    toolCalls: [{
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: "{ \"city\": \"Chicago\" }" },
    }],
  }, false);
  const joined = frames.join("");
  assert.match(joined, /"index":0/);
  assert.match(joined, /"id":"call_1"/);
  assert.match(joined, /get_weather/);
  const toolFrame = JSON.parse(frames[1].slice("data: ".length));
  assert.equal(
    toolFrame.choices[0].delta.tool_calls[0].function.arguments,
    "{ \"city\": \"Chicago\" }",
  );
});

test("stream usage is emitted only when requested", () => {
  const without = sseFrames(result, false).join("");
  const withUsage = sseFrames(result, true).join("");
  assert.equal(without.includes("prompt_tokens"), false);
  assert.equal(withUsage.includes('"choices":[]'), true);
  assert.equal(withUsage.includes('"prompt_tokens":4'), true);
});
