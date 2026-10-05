# Calypso

Local multi-agent runtime. A team lead plans work into small steps, a worker runs one step, and core checks that step before the next one starts. Failed checks retry the same step a bounded number of times, then fail upward. There is no cloud escalation path.

## Packages

| Package | Role |
| --- | --- |
| `@calypso/shared` | Additive contracts: plans, step status, check results, team events, `team.message` / `team.delegate` schemas. |
| `@calypso/core` | Plan → check → retry orchestration. Depends only on `@calypso/shared`. |

Browser and windows-control stay out of core. They report `ToolOutcome` values and can implement the shared `VerifyHook`.

## Contract policy

Changes to `@calypso/shared` are additive. Add optional fields or a new event `type`. Do not rename, remove, or repurpose fields that are already in the package. The field list for this iteration is in [`packages/shared/README.md`](packages/shared/README.md).

## Loop

```
goal → planner → discrete steps
for each step, up to maxAttempts (default 3, hard cap 3):
  delegate to a local worker
  check the attempt
  pass → mark the step done and start the next step
  fail with attempts left → retry the same step
  fail with the cap spent → mark the plan failed and stop
```

Check order for one attempt:

1. Missing result fails as `worker_report`.
2. Any `toolOutcomes[]` entry with `ok: false` fails as `tool_outcome`. A host code such as `empty_extract` is included in the reason. Tool evidence overrides a worker that claims success.
3. `result.ok !== true` fails as `worker_report`.
4. Blank success criteria fails as `success_criteria`.
5. A run-level `VerifyHook`, when set, decides the rest (`verify_hook`).
6. Otherwise `criteriaMet` must be `true` (`success_criteria`).

`execution` is always `"local"`. Payloads that set `execution`, `escalate`, `escalation`, or `mode` to anything else throw `CloudEscalationDisabledError` and are not retried.

## Install

From the repo root:

```bash
pnpm install
pnpm test
pnpm build
```

`pnpm test` runs the core plan/check/retry suite. `pnpm build` emits `dist` for `@calypso/shared` and `@calypso/core` (Node 22+).

## Wiring

Tyran should call `runTeamTask` from the desktop lead. Do not grow a second retry loop in the UI, and do not add a cloud fallback when `ok` is false. Surface `failure.reason` to the user. Subscribe to `onEvent` for the timeline (`plan.created`, `step.delegated`, `step.checked`, `step.retrying`, `step.done`, `step.failed`, `plan.completed`, `plan.failed`).

```ts
import { runTeamTask } from "@calypso/core";
import type { StepResult, VerifyHook } from "@calypso/shared";

const verify: VerifyHook = async () => {
  // Plug windows-control or browser host probes in here.
  return { ok: true, source: "verify_hook", reason: "host confirmed" };
};

const workers = {
  async execute(): Promise<StepResult> {
    // Local WorkerRuntime only. Return tool outcomes from the host packages.
    return { ok: true, summary: "saved", criteriaMet: true, toolOutcomes: [] };
  },
};

const outcome = await runTeamTask({
  goal: userText,
  workers,
  verify,
  onEvent(event) {
    renderTimeline(event);
  },
});

if (!outcome.ok) {
  showToUser(outcome.failure.reason);
}
```

`runTeamTask` is the multi-step lead. `createTeamDelegateTool` checks and retries a single step through the same policy and stops there. `createTeamMessageTool` writes to an in-process mailbox. Pass explicit `steps` to skip the deterministic planner. A goal written as numbered lines or bullets is split by `decomposeGoal`; other goals become one step. Use `::` for success criteria and `@role` for the assignee (`- @editor Replace the title :: Title reads Calypso`).
