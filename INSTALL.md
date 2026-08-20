# INSTALL.md — Agent install into an existing DeepSeek Harness

**Audience:** an automated agent (or human following agent-style steps) installing  
`dsh-model-router` + `dsh-local-model-guard` into a **pre-existing, already-built** DeepSeek Harness checkout.

**Do not** rebuild Harness unless install verification fails for missing packages.  
**Do** use absolute paths everywhere. **Do** stop and report if any step fails.

---

## 0. Preconditions (verify first)

Confirm all of the following before changing anything:

| Check | How |
|-------|-----|
| Harness checkout exists | Directory contains `package.json`, `pnpm-workspace.yaml`, and can run `pnpm dsh --help` or equivalent |
| Dependencies installed | `node_modules` present; prefer `pnpm` |
| Build artifacts exist | User has already run `pnpm install` and `pnpm run build` at least once |
| Node version | Harness requires a supported Node (typically `^22.19 \|\| >=24`; odd majors often unsupported) |
| This plugin repo is available | Clone or path to `deepseek-local` (this repository) |

Record:

- `HARNESS_ROOT` = absolute path to the deepseek-harness checkout  
- `PLUGIN_ROOT` = absolute path to this `deepseek-local` clone  

Example:

```text
HARNESS_ROOT=/home/user/src/deepseek-harness
PLUGIN_ROOT=/home/user/src/deepseek-local
```

---

## 1. Clone this plugin repo (if not already present)

```bash
git clone https://github.com/ethanturk/deepseek-local.git "$PLUGIN_ROOT"
cd "$PLUGIN_ROOT"
git status
```

If the directory already exists, `git pull` only if the user asked for the latest version.

---

## 2. Materialize absolute paths in the patch file

Harness `--patch` rows require **absolute** plugin module paths.

### 2.1 Preferred: combined patch

```bash
cp "$PLUGIN_ROOT/dsh-combined-patch.yml" /tmp/dsh-local-combined.patch.yml
```

Replace every `ABSOLUTE_REPO_ROOT` with the real `PLUGIN_ROOT`:

```bash
# POSIX sed (Linux)
sed -i "s|/ABSOLUTE_REPO_ROOT|$PLUGIN_ROOT|g" /tmp/dsh-local-combined.patch.yml

# macOS sed
# sed -i '' "s|/ABSOLUTE_REPO_ROOT|$PLUGIN_ROOT|g" /tmp/dsh-local-combined.patch.yml
```

Verify:

```bash
grep -n "name:" /tmp/dsh-local-combined.patch.yml
# Both paths must be absolute and point at:
#   .../dsh-model-router/src/index.ts
#   .../dsh-local-model-guard/src/index.ts
test -f "$PLUGIN_ROOT/dsh-model-router/src/index.ts"
test -f "$PLUGIN_ROOT/dsh-local-model-guard/src/index.ts"
```

### 2.2 Optional: edit in-repo copies

You may instead rewrite `$PLUGIN_ROOT/dsh-combined-patch.yml` and the per-plugin `cordis.yml` files in place. Prefer a **copy under `/tmp`** so the git tree stays clean.

---

## 3. (Optional) Configure tiers and providers

Default tiers assume:

| Tier | provider (default) | model (default) | local guardrails | reasoningEffort |
|------|--------------------|-----------------|------------------|-----------------|
| fast | ollama | qwen2.5:7b | true | off |
| medium | deepseek-official | deepseek-v4-flash | false | high |
| smart | deepseek-official | deepseek-v4-pro | false | max |

**Before first run**, align `provider` / `model` with providers already configured in the user’s Harness install (`Settings → Models`, or `$DSH_HOME` / profile settings).

To override without editing TypeScript defaults, put a `config:` block under each plugin row in the patch YAML (see comments in `dsh-combined-patch.yml`).

Minimum agent checklist:

1. List configured providers in the running Harness (UI or settings files).  
2. Set `fast` to a local provider if available (e.g. Ollama).  
3. Set `medium` / `smart` to real cloud or local IDs the user has keys for.  
4. Leave `enableLocalGuardrails: true` only on tiers that should get strict tool-loop monitoring (typically local/small).

If the user has **no** Ollama / DeepSeek credentials yet, **do not invent keys**. Report that model selection must be configured and stop after loading plugins with clear warnings.

---

## 4. Load plugins into Harness

From **`HARNESS_ROOT`**:

```bash
cd "$HARNESS_ROOT"
pnpm dsh web --patch /tmp/dsh-local-combined.patch.yml
```

Notes:

- If the CLI entry is `pnpm dsh` vs `npx @deepseek-ai/dsh`, use whatever this checkout already uses successfully.  
- Multiple `--patch` flags may work on some builds; the combined file is the supported path for this repo.  
- Default UI is often `http://127.0.0.1:3080`.  
- Use `--no-open` if running headless / over SSH.

**Headless one-shot (if supported by this Harness build):**

```bash
pnpm dsh --profile headless --patch /tmp/dsh-local-combined.patch.yml "ping"
```

---

## 5. Verification (agent must perform)

### 5.1 Startup logs

Expect lines similar to:

```text
[dsh-model-router] loaded – virtual model "Auto (Tiered Router)", tiers: fast → medium → smart
[dsh-local-model-guard] loaded – maxFailures=2, maxRepeated=2, window=6, ...
```

If either line is missing:

1. Confirm absolute paths in the patch resolve (`test -f ...`).  
2. Confirm TypeScript is loadable (Harness often uses `tsx` / built loader).  
3. Capture full stderr and stop.

### 5.2 Functional checks

| Test | Expected |
|------|----------|
| Select virtual model **Auto (Tiered Router)** if it appears in the picker | Router owns routing |
| Short trivial user message | Prefers **fast** tier (heuristic) |
| Complex architecture / multi-file request | Prefers **medium** or **smart** |
| Provider rejects `reasoningEffort` | Router disables effort for the agent and retries without it (log / inject) |
| On **fast** with guardrails on: force repeated identical failing tool calls | Guard injects short recovery message |

Do **not** claim success without at least startup-log verification.

### 5.3 Trajectory / session events (if available)

Look for event types or log lines:

- `model-router/classify`
- `model-router/selection`
- `model-router/validate`
- `model-router/escalate`
- `model-router/reasoning-effort-fallback`
- `local-guard/tool-failure`
- `local-guard/intervention`

Exact event APIs vary by Harness developer-preview version; absence of durable events with plugins still loading is a **soft** failure—report it, do not uninstall solely for that.

---

## 6. Persistence for the user (optional)

To avoid passing `--patch` every time:

1. Install as a profile bundle via `dsh plugin add` **if** this Harness version supports local path / git installs for bundles.  
2. Or document a shell alias / script:

```bash
alias dsh-local='pnpm dsh web --patch /tmp/dsh-local-combined.patch.yml'
```

3. Or merge the two `insert` rows into the user’s profile `cordis.patch.yml` under `$DSH_HOME/profiles/<name>/` when that workflow is already in use.

Prefer the user’s existing profile workflow; do not create new profiles unless asked.

---

## 7. Uninstall / disable

- Stop the Harness process.  
- Start **without** `--patch` (or remove the insert rows from the profile patch).  
- No Harness core files are modified by this install; removing the patch fully disables the plugins.

---

## 8. Failure matrix (agent recovery)

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Cannot find module / path error | Relative or wrong absolute path | Fix patch `name:` to real `.../src/index.ts` |
| Plugin loads, models 401 | Provider/model IDs or credentials wrong | Align tier config with configured providers; do not hardcode secrets in the patch |
| `reasoningEffort` errors | Provider does not support the effort id | Expected: router should fall back; if not, set effort to omit/`off` on that tier |
| Guard never fires | `enableLocalGuardrails: false` on current tier, or router not loaded | Enable on `fast` (or set guard `forceAlways: true` only if user requests) |
| Harness version mismatch / missing events | Developer preview API drift | Report event names and Harness commit; keep plugins loaded if logs show `loaded` |

---

## 9. Security

- **Never** commit API keys into patch YAML or this repo.  
- Store credentials only through Harness’s normal credential / settings flow.  
- This install only loads local TypeScript modules via Cordis; it does not download remote code at runtime beyond what Harness already does for models.

---

## 10. Done criteria

Report success to the user only when:

1. Patch paths are absolute and files exist.  
2. Harness starts with both plugins logging `loaded`.  
3. You stated which providers/models the tiers point at (or explicitly warned they still need configuration).  
4. You gave the exact command to relaunch with the patch.

Example success report:

```text
Installed dsh-model-router + dsh-local-model-guard into HARNESS_ROOT.
Patch: /tmp/dsh-local-combined.patch.yml
Launch: cd HARNESS_ROOT && pnpm dsh web --patch /tmp/dsh-local-combined.patch.yml
Both plugins logged "loaded".
Tiers still need provider alignment with your configured models if defaults do not match.
```
