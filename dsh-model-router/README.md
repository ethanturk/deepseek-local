# dsh-model-router

Tiered model routing + post-turn validation escalation for **DeepSeek Harness**.

Inspired by NVIDIA NeMo Switchyard (LLM classifier + escalation), implemented as a native Cordis plugin.

## Behavior (locked design)

| Decision | Implementation |
|----------|----------------|
| Tiers | 3: `fast` → `medium` → `smart` |
| Classifier | Heuristic first, LLM fallback (`mode: "both"`) |
| When to classify | Every new user message |
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

## Config overrides

Pass config via the patch row or your profile’s `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-model-router
      name: "/absolute/path/to/dsh-model-router/src/index.ts"
      config:
        tiers:
          - id: fast
            provider: ollama
            model: qwen2.5:7b
            enableLocalGuardrails: true
            reasoningEffort: off          # optional; omit for provider default
          - id: medium
            provider: deepseek-official
            model: deepseek-v4-flash
            enableLocalGuardrails: false
            reasoningEffort: high
          - id: smart
            provider: deepseek-official
            model: deepseek-v4-pro
            enableLocalGuardrails: false
            reasoningEffort: max
        classifier:
          mode: both
          provider: ollama
          model: qwen2.5:7b
        validator:
          alwaysUseTierId: smart
          maxEscalations: 2
          stickyScope: turn
```

`reasoningEffort` is an adapter-owned opaque id (e.g. `off`, `low`, `medium`, `high`, `max`).  
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

Event names (`agent/pre-step`, `agent/request`, `turn/end`, `agent/spawn`),  
`ModelSelection` / request-header seams, and session-event append APIs can move.  
The plugin uses defensive checks and logs when a seam is missing so you can adapt quickly.

## License

MIT
