# Fleet goals

A fleet goal tells GOAT what should be true, such as "these pull requests are merged" or "each
worker reported a result", and GOAT keeps working toward it. It starts the worker threads the goal
asks for, sends a short follow-up when a worker finishes without getting there, and stops when
every condition holds. Goals are off until you turn them on.

## Turn goals on

Goals do nothing until the server setting `fleet.controllerEnabled` is on. Turning it off again
stops every goal on the next check without touching running threads.

## Declare a goal

An agent running inside a GOAT thread declares a goal with `goat_call {path:"goal.apply"}`. The goal then acts as
that thread: workers never get more access than the thread had when it declared the goal, and later
updates can only lower that. Workers run on this machine for now.

This goal starts two workers, each on its own branch from `dev`, and is done when the pull
requests they open are merged and each has reported its result:

```json
{
  "title": "Fix the flaky server tests",
  "clientRequestId": "flaky-tests-2026-10-20",
  "spec": {
    "kind": "pr_bundle",
    "project": { "host": null, "projectId": "<your project id>", "cwd": null },
    "repo": "goat-si/goat",
    "targets": [{ "type": "prompt", "key": "flaky", "text": "Make the flaky server tests pass." }],
    "workers": {
      "count": 2,
      "modelSelection": { "instanceId": "codex", "model": "gpt-6.1-sol" },
      "runtimeMode": "full-access",
      "promptTemplate": "{{target}} Work on branch {{branch}} and open a pull request.",
      "workspace": { "baseRef": "dev", "branchPrefix": "goal/flaky", "startFromOrigin": true }
    },
    "doneWhen": [{ "type": "pull_requests_merged" }, { "type": "thread_reported_result" }]
  }
}
```

Retrying with the same `clientRequestId` returns the same goal. To change a goal, apply it again
with its `id`. Pass `dryRun: true` to check a spec without saving it.

## Follow a goal

The `goal.get` path shows a goal's phase (`pending`, `progressing`, `blocked`, `degraded`,
`succeeded`, `failed`, `paused` or `deleting`), its workers and their threads, and its
recent events, which say what GOAT did and why. `goal.list` lists the goals your thread
declared.

Each worker run gets at most one follow-up: when CI fails on its pull request, or when it finished
without opening a pull request or reporting. A run a person interrupted is left alone. A goal stops
and asks for a person when it reaches its limits (by default 3 workers, 3 attempts each, 40 runs
and 24 hours).

## Pause, resume, or delete

`goal.pause` stops GOAT from acting on a goal until `goal.resume`. `goal.delete`
interrupts the goal's running workers and then removes it; `force: true` removes it at once. Threads,
worktrees and branches always stay. Only the thread that declared a goal, or a thread with full
access, can pause or delete it.
