# `@calypso/shared`

Contracts for local Calypso orchestration. `@calypso/core` is the first consumer. Browser and windows-control should depend on this package, not on core.

## Additive policy

This is the initial contract surface. Later changes add optional fields or new `TeamEvent["type"]` values. Do not rename, remove, or change the meaning of the names below.

## This iteration

Constants:

- `LOCAL_EXECUTION` (`"local"`) and `ExecutionMode`
- `DEFAULT_MAX_ATTEMPTS` (`3`) and `MAX_ATTEMPTS_CAP` (`3`)

Plan and check:

- `StepStatus`: `pending`, `delegated`, `checking`, `retrying`, `done`, `failed`
- `PlanStatus`: `running`, `completed`, `failed`
- `StepCheckSource`: `worker_report`, `tool_outcome`, `verify_hook`, `success_criteria`
- `ToolOutcome` (`tool`, `ok`, optional `detail`, optional `code`)
- `StepResult` (`ok`, `summary`, optional `toolOutcomes`, `output`, `criteriaMet`)
- `StepCheckResult` (`ok`, `source`, `reason`)
- `VerifyHook` / `VerifyHookInput`
- `PlannedStepDraft`, `PlanStep` (`attempt`, `maxAttempts`, `execution`, optional `lastCheck`, `lastResult`)
- `PlanFailure`, `TeamPlan`
- `Planner`, `PlanRequest`, `DispatchRequest`

Events (`TeamEvent`):

- `plan.created`, `step.delegated`, `step.checked`, `step.retrying`, `step.done`, `step.failed`, `plan.completed`, `plan.failed`

Tools:

- `team.message` / `TeamMessage` / `TeamMessageArgs`
- `team.delegate` / `TeamDelegateArgs`
- `TEAM_MESSAGE_TOOL`, `TEAM_DELEGATE_TOOL`

`ToolOutcome.code` is an open string so host packages can report codes such as `empty_extract` without a core change. Core fails the check whenever `ok` is false.
