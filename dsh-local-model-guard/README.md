# dsh-local-model-guard

Strict monitoring for **failed tool calls** and **repetitive loops**, aimed at flaky local / small models in DeepSeek Harness.

Designed to pair with **`dsh-model-router`**: guards only run when the current tier has `enableLocalGuardrails: true` (or when the router is not present).

## Behavior

| Feature | Default |
|---------|---------|
| Max consecutive tool failures | **2** (intervene early) |
| Max repeated tool+args signature | **2** (window of 6) |
| Light retries on transient tool errors | 1 retry |
| Intervention cooldown | 6 seconds |
| System-prompt hint (tiny) | on |
| Force always (ignore router) | off |
| Recovery message | short, actionable, ~40 tokens |

### When guards apply

1. **`forceAlways: true`** → always enforce  
2. Else if **`ctx.modelRouter`** exists → enforce only when `isLocalGuardrailsEnabled(agentId)` is true  
3. Else (no router) → enforce by default  

Typical `model-router` section in `~/.dsh/settings.yaml`:

```yaml
model-router:
  tiers:
    - id: fast
      provider: local
      model: your-fast-local-model-id
      enableLocalGuardrails: true
    - id: medium
      provider: local
      model: your-medium-local-model-id
      enableLocalGuardrails: true
    - id: smart
      provider: local
      model: your-smart-local-model-id
      enableLocalGuardrails: true
```

### Intervention

When thresholds are hit, the plugin:

1. Injects a **short** recovery message (keeps context small)
2. Resets counters to avoid spam
3. Emits a `local-guard/intervention` session event (when the seam exists)

Optional light retries wrap `tools/execute` for transient errors only (timeout, connection, 502/503).

## Load

```bash
# Alone
pnpm dsh web --patch /absolute/path/to/dsh-local-model-guard/cordis.yml

# With the router (recommended)
pnpm dsh web \
  --patch /absolute/path/to/dsh-model-router/cordis.yml \
  --patch /absolute/path/to/dsh-local-model-guard/cordis.yml
```

Or merge both `insert` rows into one patch file.

## Config example

```yaml
- insert:
    - id: dsh-local-model-guard
      name: "/absolute/path/to/dsh-local-model-guard/src/index.ts"
      config:
        maxConsecutiveFailures: 2
        maxRepeatedCalls: 2
        windowSize: 6
        enableRetries: true
        maxRetries: 1
        forceAlways: false
        recoveryMessage: "Tool calls failed or repeated. Do not retry the same call. State the error in one sentence, then try a different approach."
```

## Developer-preview notes

Listens on `tools/result`, `tools/post-execute`, `tools/execute`, `agent/pre-step`, `agent/turn-stopping`, `turn/end`.  
Exact payload shapes may differ across Harness builds—handlers are defensive.

## License

MIT
