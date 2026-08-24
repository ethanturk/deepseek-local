# dsh-goal-recovery

Native DSH session-restart notifications for goals needing explicit recovery.

## Notices

After `agent/session-start` listeners finish, plugin inspects persisted goal
state. It shows native question in exactly two cases:

1. **Resume required:** goal is active, disarmed, and below configured round
   limit. This covers a reopened session whose goal remains active and goals
   whose latest turn ended with `interrupted: true`.
2. **Round limit:** goal is blocked for `round-limit`, or active and disarmed
   after reaching configured round limit.

It intentionally stays silent when no goal exists, or goal is armed, paused,
complete, or active with a different activation/state. It also stays silent
for blocked goals whose reason is not `round-limit`. Repeated session starts
for same agent and goal revision do not create duplicate pending questions.
Disposed agents and disposed plugins are ignored.

## Actions

Resume-required notice offers exactly:

- **Resume goal** — resume captured goal reference.
- **Leave paused** — leave goal paused; no resume occurs.

Round-limit notice offers exactly:

- **Acknowledge** — acknowledge stop; no resume occurs. Increase configured
  goal limit before resuming.

Plugin resumes only after exact native answer `Resume goal` for
`goal-recovery` question. It passes exact persisted `{ id, revision }` captured
when notice was created. If revision is stale, transition invalid, or another
resume error occurs, it logs failure and fails closed: never reads fresh goal
or retries with new revision.

Notification itself makes zero model calls and consumes zero model tokens. It
has no settings and reads no environment variables.

## Installation

Standalone installation uses included `cordis.yml` bundle patch:

```bash
pnpm dsh web --patch /absolute/path/to/deepseek-local/dsh-goal-recovery/cordis.yml
```

For combined installation, replace `ABSOLUTE_REPO_ROOT` in repository root's
`dsh-combined-patch.yml` and load that patch from DSH. Combined patch includes
this plugin alongside model router, local model guard, and OpenAI gateway.

This is a developer preview. Plugin depends on DSH goal persistence and native
user-question lifecycle contracts; those contracts must be available in
Harness version loading plugin.
