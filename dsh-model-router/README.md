# dsh-model-router

Tiered model routing + post-turn validation escalation for **DeepSeek Harness**.

Inspired by NVIDIA NeMo Switchyard (LLM classifier + escalation), implemented as a native Cordis plugin.

## Behavior (locked design)

| Decision | Implementation |
|----------|----------------|
| Tiers | 3: `fast` → `medium` → `smart` |
| Classifier | Conservative heuristic + LLM (`mode: "both"` keeps the more complex result) |
| When to classify | Every new user message, using recent conversation context |
| Semantic use cases | Ordered rules may choose the initial tier before complexity routing; disabled by default and never lock later escalation |
| When to validate | After a turn ends |
| On validation fail | Re-generate last assistant response on a higher tier |
| Stickiness | Configurable; default = current turn |
| Virtual model | Exposed (`auto-tier` / "Auto (Tiered Router)") |
| Subagents | Start one tier below parent |
| Classifier/validator failure | Put user in the loop |
| Persistence | Routing & validation decisions written to session events |
| Local guardrails | Per-tier boolean (default `false`) |
| Reasoning effort | Per-tier optional `reasoningEffort` (passed into ModelSelection / request) |
| Effort failures | Detect unsupported/flaky effort → disable for agent, retry without it |

## Heuristic scoring

- Hard keywords: **+2**
- Medium keywords: +1
- Length, file mentions, multi-step language, questions, context signals
- ≤2 → simple, 3–5 → medium, ≥6 → hard

## Quick start (scratch / --patch)

From a `deepseek-harness` checkout that has been built:

```bash
# Edit cordis.yml and set the absolute path to src/index.ts
pnpm dsh web --patch /absolute/path/to/dsh-model-router/cordis.yml
```

Then select the virtual model **Auto (Tiered Router)** in the UI (or configure it as default).

## Model tier settings

The patch only loads the plugin. Put provider/model tier assignments in the
`model-router` section of the DSH settings file (normally `~/.dsh/settings.yaml`):

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
  classifier:
    mode: both
    provider: local
    model: your-fast-local-model-id
```

## Semantic use-case settings

Semantic use cases are configured in the live `model-router` section of
`~/.dsh/settings.yaml`. This read-only rule is copyable and disabled by
default:

```yaml
model-router:
  useCases:
    enabled: false
    rules:
      - id: read-only
        tierId: fast
        description: >
          Retrieve or display existing information without analysis,
          judgment, recommendations, or mutation.
        positiveExamples:
          - Read src/index.ts
          - Show ADO PR 81522 details
          - "I'll paginate through the threads"
        negativeExamples:
          - Review PR 81522
          - Analyze src/index.ts
          - Comment on PR 81522
          - Modify src/index.ts
```

Set `useCases.enabled` to `true` only with `classifier.mode: llm` or
`classifier.mode: both`, and provide that classifier's `provider` and `model`.
Active rules are rejected in heuristic-only mode. Rules are evaluated in order,
and a rule matches only when the full current request clearly fits it. An
explicit stronger-tier request wins; ambiguous or malformed classifier output
falls through to normal complexity routing. Validation and recovery can still
escalate a matched turn.

Optional `reasoningEffort` values belong on tier entries in DSH settings. It is an adapter-owned opaque id (e.g. `off`, `low`, `medium`, `high`, `max`).
It is written into ModelSelection and onto `agent/request` options when those seams exist.

**Flaky effort handling:** If a request fails with an unsupported / reasoning-effort-related error (`UNSUPPORTED`, message mentions effort, etc.), the router:

1. Marks `reasoningEffort` disabled for that agent/session  
2. Re-applies the same tier **without** effort  
3. Emits a `model-router/reasoning-effort-fallback` session event  
4. Injects a short system note and best-effort follow-up retry  

Subsequent steps on that agent stay on the tier but omit effort until the session is reset.

## Integration with local-model-guard

```ts
const enabled = ctx.modelRouter?.isLocalGuardrailsEnabled(agentId) ?? false;
if (enabled) {
  // apply strict failure / loop monitoring
}
```

## Developer-preview notes

Event names (`agent/pre-step`, `agent/request`, `agent/turn-stopping`, `agent/created`),
`ModelSelection` / request-header seams, and session-event append APIs can move.  
The plugin uses defensive checks and logs when a seam is missing so you can adapt quickly.

## License

MIT
