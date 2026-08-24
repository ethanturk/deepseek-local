# dsh-openai-gateway

OpenAI-compatible V1 Chat Completions gateway for the DSH `auto-tier` model
router. Each request creates a stateless, disposable DSH agent, so the same
router classification, validation, escalation, compaction, and model guards
used by interactive DSH turns also apply to API calls.

## API

- `GET /v1/models` advertises only `auto-tier`.
- `POST /v1/chat/completions` supports text messages, `temperature`, `stop`,
  `max_tokens`/`max_completion_tokens`, function tools, `tool_choice` values
  `auto` and `none`, and buffered SSE streaming.
- `n` must be `1`. Unsupported or unknown fields are rejected instead of
  silently ignored.
- Every endpoint requires `Authorization: Bearer <key>`.

The gateway buffers a routed turn until DSH accepts the final response. SSE
therefore never leaks output from a tier that the router later rejects.

## Settings

Add to the DSH settings file, normally `~/.dsh/settings.yaml`:

```yaml
openai-gateway:
  model: auto-tier
  apiKeyEnvs: [DSH_OPENAI_API_KEY]
  toolPolicy: isolated
  maxRequestBodyBytes: 4194304
  requestTimeoutMs: 600000
  maxConcurrentRequests: 2
  corsOrigins: []
```

Then export the secret into the environment that launches DSH:

```bash
export DSH_OPENAI_API_KEY='replace-with-a-long-random-secret'
```

Multiple keys are supported without storing secrets in YAML:

```yaml
openai-gateway:
  apiKeyEnvs: [DSH_OPENAI_API_KEY, DSH_OPENAI_API_KEY_OLD]
```

If no configured environment variable contains a value, authentication fails
closed. CORS is disabled by default; `corsOrigins` accepts exact HTTP(S)
origins, never `*`.

## Tool ownership

`isolated` is the default. The request sees only the function tools declared by
the API client. DSH captures a selected client tool before execution, stops the
turn, and returns standard OpenAI `tool_calls`. The client executes the tool and
sends the assistant tool-call message plus a matching `tool` result in its next
request.

`permissive` additionally exposes installed DSH tools. Those tools execute
inside DSH. A single assistant batch may not mix installed and client-owned
tools; such a batch fails with `mixed_tool_ownership` before any tool executes.
Client tools shadow installed tools with the same name for that request.

## Quick checks

```bash
curl -sS http://127.0.0.1:3080/v1/models \
  -H "Authorization: Bearer $DSH_OPENAI_API_KEY"

curl -sS http://127.0.0.1:3080/v1/chat/completions \
  -H "Authorization: Bearer $DSH_OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto-tier","messages":[{"role":"user","content":"Reply with pong."}]}'
```

SDK smoke clients live in `test/smoke-node.mjs` and `test/smoke-python.py`.
They require the official `openai` package and use `OPENAI_BASE_URL` plus
`DSH_OPENAI_API_KEY`.
