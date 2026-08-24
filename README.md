# deepseek-local

DeepSeek Harness plugins for **local-first** agent workflows:

1. **`dsh-model-router`** — tiered routing (fast → medium → smart) with classification, post-turn validation, escalation, per-tier `reasoningEffort`, and automatic fallback when effort is rejected by a provider.
2. **`dsh-local-model-guard`** — strict monitoring for failed tool calls and loops on flaky local/small models; only enforces when the router marks `enableLocalGuardrails: true` for the current tier.
3. **`dsh-openai-gateway`** — an authenticated OpenAI-compatible Chat Completions endpoint backed by the tiered router, including client-owned function calls and optional access to installed DSH tools.
4. **`dsh-goal-recovery`** — native lifecycle notification when a goal needs explicit resume or has hit its round cap.

Inspired by NVIDIA NeMo Switchyard-style routing, implemented as native Cordis plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (developer preview).

## Layout

```
dsh-model-router/          # tiered router plugin
dsh-local-model-guard/     # local model guardrails plugin
dsh-openai-gateway/        # OpenAI-compatible API gateway
dsh-goal-recovery/         # goal recovery notification plugin
dsh-combined-patch.yml     # load all plugins with one --patch
```

## Quick start

1. Clone this repo and a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) checkout; build Harness (`pnpm install && pnpm run build`).
2. Edit absolute paths in `dsh-combined-patch.yml` (or each plugin’s `cordis.yml`) to point at the `src/index.ts` files on your machine.
3. From the Harness checkout:

```bash
pnpm dsh web --patch /absolute/path/to/deepseek-local/dsh-combined-patch.yml
```

4. Select **Auto (Tiered Router)** in the model picker (or set it as default).
5. Configure providers/models for the three tiers to match accounts you have.
6. To use the gateway, set `DSH_OPENAI_API_KEY` in the DSH process environment and call `http://127.0.0.1:3080/v1` with model `auto-tier`.

On session restart or a live round-cap transition, `dsh-goal-recovery` asks a
native question when a goal needs explicit resume or has hit its configured
round cap.

## Defaults (summary)

| Tier | Typical use | Local guardrails | reasoningEffort |
|------|-------------|------------------|-----------------|
| fast | local / small | on | off |
| medium | flash-class | off | high |
| smart | frontier | off | max |

Guard defaults: intervene after **2** consecutive tool failures or **2** repeated tool+args signatures (window 6), 1 transient retry, short recovery message.

See each package README for full behavior, config, and developer-preview caveats.

## License

MIT
