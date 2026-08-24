# Goal Recovery Notification Design

## Goal

Add a standalone DeepSeek Harness plugin that immediately tells the user when an unfinished goal cannot continue automatically and offers the correct human-authorized next action without invoking a model or consuming tokens.

## Problem

DSH deliberately disarms active goals when a session resumes. Crash recovery also closes an orphaned turn with `reason.kind === "interrupted"`. These are safety mechanisms, but the durable goal can still appear active while automatic continuation is disabled. The current Goal UI does not expose process-local activation, so the user receives no visible explanation or resume action.

An actual goal round-cap exhaustion is different. The goal-round driver blocks the goal with `blockedReason.code === "round-limit"` and a message containing the configured cap. Both states require user-visible feedback, but only the disarmed active goal can be resumed immediately.

## Scope

Version 1 handles:

- An active, disarmed goal after session resume
- Extra context when the latest persisted turn ended as `interrupted`
- A goal blocked by the configured round limit
- Native user choices through `ctx.userQuestions`
- Human-authorized goal resume through `ctx.goals.resume`
- In-process duplicate suppression
- Cancellation and stale-goal races
- Structured plugin diagnostics

Version 1 does not:

- Resume goals automatically
- Increase `maxGoalRounds`
- Retry provider or persistence failures
- Add a custom browser bundle, RPC namespace, toast, or conversation node
- Change the built-in Goal UI
- Change `dsh-local-model-guard`
- Patch installed DSH packages
- Notify for user-aborted, completed, paused, or unrelated blocked goals

## Architecture

Create a standalone host-only Cordis plugin named `dsh-goal-recovery`. It depends on the public DSH agent, goal, session, and user-question services. No client package is needed because `ctx.userQuestions.ask()` already routes a native, session-scoped question to the active DSH UI provider and waits without model inference.

The plugin listens at `agent/session-start`, after persisted session repair and goal replay have produced the live agent state. It defers classification by one microtask so all session-start listeners, including the goal service's disarm policy, settle before it reads the goal. It then classifies the current goal and latest terminal turn and starts at most one asynchronous recovery prompt for that agent runtime. The event listener does not await the human response and therefore does not block session publication.

When the user chooses `Resume goal`, the plugin calls `ctx.goals.resume(agent, originalGoalRef)`. The goal service supplies the compare-and-set fence, validates remaining round capacity, and arms continuation. Any stale revision or invalid transition is reported without substituting a newer goal ref or retrying automatically.

## Package Structure

```text
dsh-goal-recovery/
├── src/index.ts
├── src/classify.ts
├── src/types.ts
├── test/classify.test.ts
├── test/plugin.test.ts
├── package.json
├── cordis.yml
└── README.md
```

- `index.ts`: Cordis lifecycle, DSH service calls, prompt dispatch, cancellation, and diagnostics.
- `classify.ts`: pure recovery-state classification from a `GoalView` and latest `turn/end` event.
- `types.ts`: internal recovery notice and decision types.
- `classify.test.ts`: table-driven state classification coverage.
- `plugin.test.ts`: user-question, resume, deduplication, cancellation, and race contracts.

## Recovery Classification

The classifier receives the live `GoalView`, if any, plus the latest persisted `turn/end` event, if any. It returns one of three results:

1. `resume-required`
   - Goal phase is `active`.
   - Goal activation is `disarmed`.
   - Remaining capacity exists: `roundsStarted < maxGoalRounds`.
   - Latest turn reason is retained as optional explanatory context.
2. `round-limit`
   - Goal phase is `blocked` and `blockedReason.code === "round-limit"`; or
   - Goal is active and disarmed with `roundsStarted >= maxGoalRounds`, covering interruption before the driver durably records its block.
3. No notice
   - No goal exists.
   - Goal is armed, paused, complete, or blocked for another reason.

An interrupted turn is not described as a round-limit failure. Copy and diagnostics must preserve this distinction.

## User Interaction

### Disarmed active goal

The plugin asks one single-select question:

- Header: `Goal paused`
- Question: `This goal cannot continue automatically. What should DSH do?`
- Detail after interruption: `The previous turn was interrupted before completion. DSH preserved the goal and requires your approval before continuing.`
- Detail after another session-resume path: `DSH preserved the active goal but disabled automatic continuation when the session resumed.`
- Options:
  - `Resume goal` — resume the exact live goal revision.
  - `Leave paused` — take no state-changing action.

Custom text and an empty selection are treated as `Leave paused`. The plugin never interprets free text as authorization.

### Round limit

The plugin asks an informational question:

- Header: `Goal round limit`
- Question: `Goal stopped after {roundsStarted}/{maxGoalRounds} rounds.`
- Detail: `Increase the goal's maxGoalRounds before resuming if more work is authorized.`
- Option: `Acknowledge`

Version 1 does not offer a fixed increment because the correct additional budget is a user decision. Acknowledgment leaves the blocked goal unchanged.

## Lifecycle and Concurrency

Each live agent has at most one pending recovery question. State is held in a `WeakMap<Agent, PendingRecovery>` so disposed agents do not leak. The deduplication key contains the goal id, goal revision, notice kind, and latest terminal-turn sequence when present.

The plugin creates an `AbortController` for each question. `agent/disposed` and plugin disposal abort the pending question and clear state. `ASK_ABORTED` during teardown is expected and logged only at debug level. `NO_PROVIDER`, malformed responses, and other service failures produce a warning and a `goal-recovery/notice-failed` diagnostic; they never wake the model or mutate the goal.

Questions are intentionally eligible to appear again after a later session resume while the same unresolved state remains. Suppression is runtime-local, not durable: silently hiding an unresolved recovery condition on future visits would recreate the original problem.

## Race Handling

The question captures the exact `GoalRef` shown to the user. Before a resume mutation, the plugin does not replace that ref with the latest revision. `ctx.goals.resume()` therefore rejects if another action edited, paused, blocked, completed, cleared, or resumed the goal while the question was open.

`GOAL_STALE_REVISION` and `GOAL_INVALID_TRANSITION` are surfaced as recovery failures and leave current state untouched. The plugin does not guess whether the newer state still matches the user's earlier approval.

## Diagnostics

The plugin emits concise structured diagnostics through the DSH logger:

- `goal-recovery/notice-opened`
- `goal-recovery/resumed`
- `goal-recovery/left-paused`
- `goal-recovery/round-limit-acknowledged`
- `goal-recovery/notice-failed`
- `goal-recovery/resume-failed`

Diagnostics include agent id, goal id, goal revision, notice kind, and stable error code where available. They exclude the goal objective, question free text, model content, and credentials.

## Configuration

Version 1 has no settings. Recovery semantics come from DSH goal state and public service contracts. `cordis.yml` only loads the plugin. Adding enable flags, custom copy, timeouts, or round-budget increments is deferred until real usage demonstrates a need.

## Installation

The plugin is added to the repository's combined DSH plugin patch and installed using the same local-plugin workflow as the router, local-model guard, and OpenAI gateway. DSH must restart after installation so Cordis loads the new package.

No changes belong in `settings.yaml` because Version 1 exposes no configuration.

## Verification

Required automated coverage:

- Active, disarmed goal with remaining capacity returns `resume-required`.
- Interrupted terminal reason selects interruption-specific detail.
- Non-interrupted session resume selects generic disarm detail.
- Blocked `round-limit` goal returns exact admitted and maximum round counts.
- Active, disarmed goal with exhausted capacity also returns `round-limit`.
- Armed, paused, complete, absent, and unrelated blocked goals produce no notice.
- One agent runtime opens only one matching question.
- `Resume goal` calls `ctx.goals.resume()` once with the captured agent and exact goal ref.
- `Leave paused`, custom text, and empty selection perform no goal mutation.
- Round-limit acknowledgment performs no goal mutation.
- Stale revision and invalid transition failures do not retry with a newer ref.
- Agent disposal and plugin disposal abort pending questions.
- Missing UI provider and aborted questions do not start a model turn.
- Question waiting and acknowledgment produce no `agent/request` or model-router decision.

Required smoke coverage:

1. Start an active goal and interrupt DSH mid-turn.
2. Restart DSH and reopen the session.
3. Confirm native recovery question appears immediately.
4. Choose `Leave paused`; confirm no model request occurs.
5. Reopen again, choose `Resume goal`, and confirm the next admitted goal round runs through `auto-tier`.
6. Run a goal to its configured round cap and confirm the `N/N` acknowledgment appears without offering resume.

Existing model-router, local-model-guard, and OpenAI-gateway tests must remain green.

## Alternatives Rejected

### Inject model context from local-model guard

`agent.inject()` is non-waking context for a later model step, not an immediate user alert. The local-model guard is also tier-gated, while goal recovery must work independently of model selection.

### Custom browser plugin and RPC

A dual-face package could render a banner and expose process-local activation through a custom remote method. DSH already provides the required user-question UI and goal-resume service, so that design adds unnecessary browser, transport, localization, and lifecycle code.

### Automatic resume

DSH intentionally disarms goals at session boundaries. Resuming without a human choice would bypass that safety contract and could restart expensive or destructive work after a crash.

### Patch built-in Goal UI

An upstream Goal UI enhancement may be valuable later, but editing installed DSH packages is not durable and is unnecessary for the local plugin fix.
