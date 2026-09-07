# dsh-llm-verifier

LLM-as-a-Verifier post-turn scoring for DeepSeek Harness, ported from
[llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)
(progress-tracking variant; see the accompanying paper).

Instead of asking a judge for a binary pass/fail, the verifier model is
asked to emit `<c1>LETTER</c1>` where the letter comes from a calibrated
20-letter progress scale (A = certainly not done … T = essentially certain
done). The plugin reads the **top-K token logprobs** at the answer position
and computes the score as the expectation over the letter-value
distribution — a continuous reward in [0, 1] instead of a hard verdict.
Each turn is scored `nEvaluations` times in parallel and averaged.

## Backend requirements

Any OpenAI-compatible Chat Completions endpoint that returns token-level
logprobs (`logprobs: true` + `top_logprobs`), e.g. vLLM, SGLang, llama.cpp,
or the DeepSeek API. `ctx.llm.stream` does not expose logprobs, so the
plugin calls `${baseUrl}/chat/completions` directly via `fetch`.

## Configuration

Settings live in the `llm-verifier` section of `~/.dsh/settings.yaml` (or
plugin `config:` in the patch file):

```yaml
llm-verifier:
  baseUrl: http://127.0.0.1:8000/v1
  apiKeyEnv: OPENAI_API_KEY      # env var read for the Bearer key (optional)
  model: my-verifier-model     # required — empty disables verification
  nEvaluations: 2              # repeats averaged per turn
  topLogprobs: 20              # OpenAI API caps at 20
  maxTokens: 1024
  timeoutMs: 60000
  threshold: 0.5               # score below this = failed verification
  maxTrajectoryChars: 24000
  maxStepChars: 2000
  criteria: []                 # optional [{name, description}] appended to the prompt
  steerOnLowScore: true
```

`model` must be set; an empty model means "not configured" and the plugin
is inert.

## Interaction with dsh-model-router

When `dsh-model-router` is loaded, the router calls
`ctx.llmVerifier.scoreTurn(...)` from its post-turn validation path and
replaces the binary JSON judge. A score below `threshold` produces the
reason `LLM verifier score X below threshold Y`, which drives the router's
usual tier escalation and regeneration steering. If the verifier call
fails, the router falls back to the JSON judge.

Without the router, the plugin steers the agent directly on
`agent/turn-stopping` when the score is below threshold — at most once per
user message — telling it to re-check observed outputs and verify the
result before finishing.

## Session events

Scores are persisted as `llm-verifier/score` events with
`{score, threshold, passed, steps, perRep}` when the sessions service is
available.

## License

MIT
