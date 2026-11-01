# ADR-0016 — decision recorded under "Fleet goals"

- Contract owner: [launch-and-remote-dispatch.md](../launch-and-remote-dispatch.md#fleet-goals)
- Commit: pending on branch docs/agentic-k8s-design (recorded before implementation, 2026-10-20)
- Design: [agentic-k8s.md](../../docs/internals/agentic-k8s.md)

## Decision record

- 목적과 의도: Let a person or agent declare durable desired state ("finish this PR bundle", "keep three threads on these issues until merged with green CI") and have the server keep comparing it with observed threads, runs, PRs and CI, instead of a person or GOAT Bot looping by hand.
- 기존 구현 및 제약 조건: Periodic work registers on `Scheduler.register` (`apps/server/src/scheduling/Scheduler.ts`), a 5 s tick with one permit per source that waits for startup recovery. `UsageLimitRecoveryWorker.ts` shows the idempotent pattern: a pure function maps an observation to one command with a deterministic id. Remote threads are followed by launch watches (ADR-0009), including launcherless watches with an owner and a runtime-mode ceiling. Nothing stores a goal.
- 검토한 주요 대안:
  - Model goals as orchestration events and projections. Goals are not thread-scoped, and this adds client contracts for state no client renders yet.
  - Keep goals in a JSON file like launch watches. Goals need queries by due time, per-row compare-and-set on generation, and migrations.
  - Edge-triggered only, acting on launch-watch reports. A lost or duplicated report would leave a goal wrong forever.
  - Let GOAT Bot keep looping in channels code. It ties fleet control to one channel surface and to code another thread is changing.
- 선택한 방식: A `FleetGoal` with spec, `generation`, and status (`observedGeneration`, Kubernetes-style conditions, workers, events) in new SQLite tables. A level-triggered `GoalController` on the Scheduler reconciles due goals, with at most 3 actions per goal and 10 per tick, per-goal exponential backoff (30 s to 15 min), and action ids of the form `goal:<id>:s<slot>:a<attempt>:<verb>`. Launch-watch reports and PR sync only move a goal's next reconcile time. Every action is claimed first in one transaction that re-reads generation, pause, deletion, budget and the owner's current authority; a launch whose outcome is unclear moves to the next attempt instead of being resent. Workers are followed by a new `controller` kind of launch watch owned by the goal at the creator's runtime-mode ceiling. Placement, health, rescheduling and fallback are reached through service tags whose default layers keep the first release local-only.
- 다른 대안 대신 이 방식을 선택한 이유: Level-triggered reconcile tolerates missed and repeated signals, deterministic ids make crashes and repeats harmless, and the existing Scheduler and watch ceiling give the controller its cadence and authority without new machinery.
- 장점, 단점 및 영향: Goals are opt-in behind `fleet.controllerEnabled` and change nothing on upgrade. A goal belongs to one environment; there is no cross-environment goal or leader election. The SSH `clientRequestId` dedupe lasts one session, so an unclear launch costs an attempt rather than risking a resend. Goal state is not part of the orchestration event log.
