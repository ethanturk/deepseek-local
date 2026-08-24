# Task 3 Report

## Scope

- Added `dsh-goal-recovery/src/questions.ts`.
- Added `dsh-goal-recovery/test/questions.test.ts`.
- No other source files changed.
- No applicable `STYLE.md` files were found under the worktree.

## Implementation

- `recoveryQuestion()` builds native `AskUserQuestionRequest` objects for interrupted resume, ordinary restart, and round-limit notices.
- Requests use stable id `goal-recovery`, exact caller `agent`, caller `signal`, and `multiSelect: false`.
- UI text contains round usage and does not include the goal objective.
- `choseResume()` accepts only `goal-recovery` answers containing exact selected label `Resume goal`.
- Malformed answers are rejected safely; `Array.isArray()` guards `.includes()`.

## TDD Evidence

- RED: `node --test dsh-goal-recovery/test/questions.test.ts` failed with `ERR_MODULE_NOT_FOUND` for missing `src/questions.ts`.
- GREEN: focused test passed, 5/5.

## Verification

- `node --test dsh-goal-recovery/test/questions.test.ts`: 5 passed, 0 failed.
- `npm test` in `dsh-goal-recovery`: 16 passed, 0 failed.
- `npm run typecheck` in `dsh-goal-recovery`: exit 0.

## Concerns

- None known. Wording is intentionally limited to recovery state and round counts; objective remains excluded.
