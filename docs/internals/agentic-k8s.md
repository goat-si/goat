# Agentic Kubernetes: goals, controller, self-healing, resources, fallback

Status: proposal, with T1 (goals and the controller) implemented as its **Now** paragraph says.
Nothing else below is implemented unless a paragraph is marked **Now**.

**Now** describes `dev` at `876c09947` with source paths. **Proposed** is design that
does not exist yet. Unlabeled text inside a Proposed section is also proposal.

## Why this exists

GOAT already has most of a cluster. The parent environment is a control plane, SSH hosts are
nodes, threads are workloads, worktrees isolate them, `goat_host_status` reports node
metrics, and the shared SSH runtime bootstrap joins a node. Three pieces are missing, and today a
person or a bot thread plays them by hand:

1. **Desired state with a reconcile loop.** Nobody can declare "finish these four PRs" or "keep
   three threads on issues #a, #b, #c until they are merged with green CI" and have the server keep
   comparing that wish with what threads, PRs and CI actually show.
2. **Self-healing.** When a host disconnects or a thread stops making progress, someone has to
   notice, decide whether the work is lost, and relaunch it elsewhere from the pushed branch.
3. **Resources and fallback.** Nothing caps how many threads run per host or per goal, nothing
   spends a model budget, and when a model hits its usage limit the thread waits for the reset even
   when another configured model could continue.

This page designs those three pieces on top of what exists. It is split so three implementation
threads (T1, T2, T3 below) can work in parallel against fixed service interfaces.

## Mapping

| Kubernetes            | GOAT now                                                                                            | GOAT proposed                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Control plane         | The environment the user drives (`apps/server`)                                                     | Same; the controller runs in the environment that owns the goal  |
| Node                  | SSH host or this machine (`apps/server/src/sshRemote/SshRemoteDispatch.ts`)                         | Same, plus a persisted host state (cordoned, draining)           |
| Node status           | `goat_host_status` (`apps/server/src/mcp/HostStatusMcpService.ts`, `hostStatusModel.ts`)            | Host conditions derived by `HostHealthMonitor` (T2)              |
| Node heartbeat        | Launch watch outages (`apps/server/src/mcp/launchWatch.ts`, `LaunchWatchOutage`, 3 failed contacts) | Same signal, read by `HostHealthMonitor`                         |
| Pod                   | A thread and its runs                                                                               | A goal worker attempt: one launched thread with a lease          |
| Deployment / Job      | None; a person or GOAT Bot loops by hand                                                            | **Goal** (T1)                                                    |
| Controller            | Ad hoc sweeps on `apps/server/src/scheduling/Scheduler.ts` (e.g. `UsageLimitRecoveryWorker.ts`)     | `GoalController` registered on the same Scheduler (T1)           |
| Scheduler             | `choosePlacement` for channel tasks only (`apps/server/src/channels/channelPlacement.ts`)           | `PlacementScheduler`: filters, then the same score (T3)          |
| Requests / limits     | `DispatchModeLimit.ts`, `LiveStreamBudget.ts`, GOAT Bot cap of four items per requester (#483)      | `ResourcePolicy`: per-host, global and per-goal limits (T3)      |
| ResourceQuota         | Provider quota windows in `hostStatusQuotas` (read-only)                                            | Placement filter and goal budgets (T3)                           |
| Eviction / reschedule | Channel tasks only: `ChannelRemoteWorkers.ts` `move` with `channelReplica.ts`                       | `Rescheduler` for any goal worker (T2)                           |
| Cordon / drain        | Runtime drain of one server (`runtimeDrain.ts`, ADR-0013); no host cordon                           | `goat_host_cordon`, `goat_host_uncordon`, `goat_host_drain` (T2) |
| Liveness probe        | None for agent progress                                                                             | `ThreadStallDetector` (T2)                                       |
| Image pull fallback   | None; `limitRecoveryCommand` waits for the reset                                                    | **Fallback chain** (T3) before the wait                          |
| Dashboard             | Fleet tab (`packages/client-runtime/src/state/fleet.ts`)                                            | Read-only goal and host conditions, later                        |

## Shared vocabulary

- **Goal.** A durable desired-state object: what work should exist, where it may run, when it is
  done, and what it may spend. Spec changes bump `generation`.
- **Worker.** One slot in a goal (slot 0..n-1). A slot has at most one live **attempt**: a launched
  thread on one host. A reschedule ends the attempt and starts the next one.
- **Controller.** The loop that compares a goal's spec with what it observes and takes a bounded
  number of idempotent actions.
- **Host conditions.** `Ready`, `Unreachable`, `Cordoned`, `Draining`, `VersionMismatch` (warning
  only), and `QuotaExhausted` per provider instance.
- **Fallback chain.** An ordered list of model selections a thread may move to when its current one
  fails with a listed failure class.

## Goal object

**Proposed (T1, `packages/contracts/src/fleetGoal.ts`).**

```ts
type FleetGoal = {
  id: FleetGoalId; // "goal_<ulid>"
  title: string;
  generation: number; // +1 on every spec change
  owner: {
    // Who applied the goal. Actions run with this principal's authority, never more.
    kind: "thread" | "mcp_client";
    threadId: ThreadId | null;
    mcpOwner: string | null; // MCP request namespace, as LaunchWatch.owner
    runtimeModeCeiling: RuntimeMode; // captured at apply, lowered on update, never raised by the controller
  };
  spec: {
    kind: "pr_bundle" | "issue_set" | "thread_set" | "custom";
    project: { host: string | null; projectId: ProjectId | null; cwd: string | null };
    repo: string | null; // "owner/name"
    targets: ReadonlyArray<
      | { type: "issue"; number: number }
      | { type: "pull_request"; number: number }
      | { type: "branch"; name: string }
      | { type: "prompt"; key: string; text: string }
    >;
    workers: {
      count: number; // desired live slots, 0..maxWorkers
      perTarget: boolean; // one slot per target instead of count
      hostSelector: {
        hosts?: ReadonlyArray<string | null>;
        exclude?: ReadonlyArray<string | null>;
      };
      modelSelection: ModelSelection;
      fallbackChain: string | null; // name in settings, T3
      runtimeMode: RuntimeMode; // clamped to owner.runtimeModeCeiling
      promptTemplate: string; // {{target}}, {{branch}}, {{attempt}}, {{previousAttempt}}
      workspace: { baseRef: string; branchPrefix: string; startFromOrigin: boolean };
      onHostLost: "reschedule" | "wait"; // default "reschedule"; see Fencing
    };
    doneWhen: ReadonlyArray<
      | { type: "pull_requests_merged" }
      | { type: "checks_green" }
      | { type: "thread_reported_result" }
      | { type: "issues_closed" }
    >;
    limits: {
      maxWorkers: number; // default 3, hard max 8
      maxAttemptsPerWorker: number; // default 3
      maxTurns: number | null; // default 40 across the goal
      maxWallClockMs: number | null; // default 24 h
      maxTokens: number | null; // counted only where the provider reports usage
    };
    paused: boolean;
  };
  status: {
    phase:
      | "pending"
      | "progressing"
      | "blocked"
      | "degraded"
      | "succeeded"
      | "failed"
      | "paused"
      | "deleting";
    observedGeneration: number;
    conditions: ReadonlyArray<GoalCondition>;
    workers: ReadonlyArray<GoalWorkerStatus>;
    usage: { turns: number; tokens: number | null; startedAt: IsoDateTime | null };
    lastReconcileAt: IsoDateTime | null;
    nextReconcileAt: IsoDateTime | null;
    failures: number; // consecutive reconcile failures, drives backoff
  };
  deletionRequestedAt: IsoDateTime | null; // finalizer-style: workers are stopped before the row goes
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

type GoalCondition = {
  type: "Ready" | "Progressing" | "Blocked" | "Degraded" | "BudgetExhausted" | "Done";
  status: "True" | "False" | "Unknown";
  reason: string; // CamelCase, e.g. "HostUnreachable", "NeedsHuman", "ChecksFailing"
  message: string; // one human line
  observedGeneration: number;
  lastTransitionTime: IsoDateTime;
};

type GoalWorkerStatus = {
  slot: number;
  target: string | null; // target key this slot owns
  attempt: number; // fencing token, starts at 1
  host: string | null;
  threadId: ThreadId | null;
  branch: string | null;
  modelSelection: ModelSelection;
  state:
    | "placing"
    | "launching"
    | "launch_unknown"
    | "running"
    | "needs_human"
    | "stalled"
    | "succeeded"
    | "failed"
    | "superseded";
  pullRequest: {
    number: number;
    state: "open" | "merged" | "closed";
    checks: "pending" | "passing" | "failing" | null;
  } | null;
  lastActivityAt: IsoDateTime | null;
  launchClientRequestId: string;
};
```

Rules taken from Kubernetes API conventions:

- `status.observedGeneration` and each condition's `observedGeneration` are the generation the
  controller actually reconciled, not a copy of the current one. A condition older than
  `generation` is stale and clients show it as such
  ([KEP-1623](https://github.com/kubernetes/enhancements/blob/master/keps/sig-api-machinery/1623-standardize-conditions/README.md)).
- Deleting a goal sets `deletionRequestedAt`. The controller interrupts live attempts and removes the
  row only after every attempt is confirmed terminal, like a finalizer
  ([finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)). An
  attempt on an unreachable host keeps the goal as a tombstone in phase `deleting` with its attempt
  records, so a returning host is still interrupted; `goat_goal_delete` with `force` drops the
  tombstone and says that work may still be running there. Threads, worktrees and branches stay;
  deleting a goal never deletes work.
- Worker threads carry the goal id in their launch watch owner, like `ownerReferences`
  ([owners and dependents](https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/)).
  A thread launched by a goal remains an ordinary thread the user can open and steer.

Events are appended to `fleet_goal_events` (bounded to the last 200 per goal):
`{at, type, reason, message, slot, attempt, actionId}`.

## Controller

**Now.** Periodic work registers on `Scheduler.register(name, runDueWork)` in
`apps/server/src/scheduling/Scheduler.ts`: a 5 s tick, one permit per source (a slow source is
skipped, not stacked), and nothing runs until startup recovery finishes (`forkParked`).
`UsageLimitRecoveryWorker.ts` is the model: a pure function maps one observation to at most one
command with a deterministic `commandId` (`limit-resume:<thread>:<run>:<reset>`), so a repeat
tick is a no-op.

**Proposed (T1, `apps/server/src/fleet/goals/`).** `GoalController` registers one source,
`fleet-goals`, on the Scheduler. It is level-triggered: every tick it reconciles the goals that are
due, reading the whole observed state each time instead of trusting the events that woke it.
Launch-watch reports (`run.completed`, `question`, `host.unavailable`) and PR sync updates only
set `nextReconcileAt = now` for the owning goal, so an edge shortens the wait but is never the
only reason to act.

```text
tick():
  if !settings.fleet.controllerEnabled: return            // kill switch, default off
  budget = MAX_ACTIONS_PER_TICK (10, across all goals)
  for goal in store.due(now) ordered by nextReconcileAt:  // at most 20 goals per tick
    if budget == 0: break
    result = reconcile(goal, budget)
    budget -= result.actions
    store.writeStatus(goal.id, goal.generation, result.status, result.events)  // CAS on generation
    store.schedule(goal.id, result.ok ? next(result) : backoff(goal.status.failures + 1))

reconcile(goal, budget):
  observed = observe(goal)                // pure read; no writes
  desired  = desiredSlots(goal.spec)      // slot -> target
  actions  = plan(goal, desired, observed) // pure, unit-tested, sorted by priority
  for a in actions.take(min(budget, MAX_ACTIONS_PER_GOAL = 3)):
    if !store.claim(goal.id, goal.generation, a.id): continue  // see "Action claims"
    run(a)                                 // idempotent by a.id
    store.settle(a.id, outcome)
  return status(goal, observed, actions)

plan(goal, desired, observed):              // first matching rule per slot
  if goal.deletionRequestedAt:     interrupt every live attempt; when none: delete row
  if goal.spec.paused:             no actions; phase = paused
  if doneWhen holds for all targets: phase = succeeded; no new launches; leave threads alone
  if budget exhausted:             phase = blocked, BudgetExhausted=True; no launches
  for slot in desired:
    w = observed.worker(slot)
    none            -> Placement.place(...) -> Launch | Refused(reason) => Blocked/Degraded condition
    launching       -> wait until LAUNCH_GRACE_MS, then count a failed attempt
    running         -> Health.threadHealth(ref):
                         healthy  -> nothing
                         stalled  -> Steer once ("status?"), then Rescheduler.reschedule(ref, "stalled")
                         hostLost -> Rescheduler.reschedule(ref, "host_unreachable")
    needs_human     -> nothing; Blocked=True reason NeedsHuman (a person answers)
    failed(class)   -> Fallback.next(selection, class) -> SwitchModel | Relaunch | Exhausted
                       Exhausted && attempts < max -> Rescheduler.reschedule(ref, "failed")
    succeeded, PR open, checks failing -> FollowUp ("CI failed: <names>; fix and push")
    succeeded, PR merged/closed or doneWhen holds for the slot -> mark slot done
  for slot in observed but not desired (spec shrank): interrupt, mark superseded
```

Action ids are deterministic so a crash between "run" and "write status" repeats the same request,
which the receiver dedupes:

| Action          | Id                                                    | Deduped by                                                                                                  |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Launch          | `goal:<id>:s<slot>:a<attempt>:launch`                 | `clientRequestId` in `goat_thread_launch` / `SshRemoteDispatch` (per SSH session) and the stored worker row |
| Steer/follow-up | `goal:<id>:s<slot>:a<attempt>:<runId>:followup`       | `commandId`/`messageId` on `message.dispatch`, as `limitRecoveryCommand` does                               |
| Model switch    | `goal:<id>:s<slot>:a<attempt>:<runId>:fallback:<hop>` | `commandId`                                                                                                 |
| Interrupt       | `goal:<id>:s<slot>:a<attempt>:interrupt`              | interrupt of a finished run is a no-op                                                                      |

### Action claims

A status write after the fact is too late to stop an action planned from an old observation, so
every action is claimed first. `store.claim` runs one SQLite transaction that re-reads the goal row
and inserts the action id into `fleet_goal_actions`. It refuses when the generation moved, the goal is
paused or being deleted, the owner's authority no longer covers the action (see
[Authority and safety](#authority-and-safety)), a hard budget is spent, or the id is already
claimed. A claimed action that was never settled is the receipt a restart reads.

The SSH dedupe of `clientRequestId` lasts one session and the remote derives the thread id from the
request namespace (`apps/server/src/mcp/OrchestratorMcpService.ts`), so it is not a durable dedupe
across restarts. A launch claim that was never settled is therefore never sent again under the same
attempt. The slot goes to `launch_unknown`; the controller looks for the attempt's branch name and
title on the host with `goat_thread_list`. Found: the slot adopts that thread. Not found after
`LAUNCH_GRACE_MS`: the slot moves to attempt + 1 on a new branch, so a late duplicate of the old
attempt is fenced as stale like any other. This is the same rule `relay_attempted` follows for
remote relays: when the outcome is unclear, report and move on, never resend blindly.

Backoff per goal: `min(30 s × 2^(failures-1), 15 min)`, the curve `launchWatch.ts` already uses
(`BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`). A successful reconcile resets `failures`, as client-go's
`Forget` does ([default_rate_limiters.go](https://github.com/kubernetes/client-go/blob/master/util/workqueue/default_rate_limiters.go)).
The normal cadence without failures is 60 s per goal, plus immediate wake-ups from edges. The 5 s
Scheduler tick and the global `MAX_ACTIONS_PER_TICK` play the part of the workqueue's overall token bucket.

One environment owns a goal. There is no leader election: the store lives in that environment's
SQLite, and the Scheduler permit already serializes the source. Two environments never share a
goal row.

### What counts as observed

| Fact                        | Source now                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread phase, run status    | `OrchestratorMcpThreadStatusResult` (`packages/contracts/src/orchestratorMcp.ts`): `phase`, `run.status`, `pendingRequest`, `lastActivityAt`, `lastError` |
| Run ended, question, outage | `LaunchWatchService` reports for the watch the goal registered at launch                                                                                  |
| Host reachable              | `LaunchWatchOutage` on the worker's watch and `goat_host_status` `reachability`                                                                           |
| PR state and checks         | PR links on the worker thread (`ThreadPullRequestService.ts`) refreshed by `PullRequestSyncReactor.ts`; `gh` only when no link exists                     |
| Issue closed                | `gh issue view` through the source-control provider, at most once per reconcile per target                                                                |
| Failure class               | `lastErrorClass` on the thread projection (`OrchestrationV2ProviderFailureClass` in `packages/contracts/src/orchestrationV2.ts`)                          |

Workers are followed by a launch watch whose `owner` is `goal:<id>` and whose `ceiling` is the
goal's runtime-mode ceiling, the fields launcherless watches already carry (`LaunchWatch.owner`,
`LaunchWatch.ceiling` in `launchWatch.ts`). Today a launcherless watch is registered only when it has
a webhook to report to, and a watch with no pending runs stops being followed, so T1 adds a
`controller` receiver kind to `LaunchWatchService`: registered without a webhook, kept while the goal
row exists, re-armed by every controller action, and readable through
`LaunchWatchService.snapshot(watchId)` (last run status, outage). The controller never polls a host
itself.

Remote thread status has no failure class today: `OrchestratorMcpThreadStatusResult` carries
`lastError` text only. T2 adds optional `run.failureClass` and `run.usageLimitResetAt` to it. A remote
that predates them reports `unknown`, which the decision table treats as "reschedule, no fallback".
New status fields are decoded with defaults so a newer parent still reads an older host; the
existing fallback in `HostThreadsMcpService.ts` only covers a missing tool.

**Now (T1).** Goals, the controller and the goal tools exist on `dev`, behind
`fleet.controllerEnabled` (default off). The pieces follow the Proposed text above, with these
differences a maintainer would otherwise trip on:

- Code: contract in `packages/contracts/src/fleetGoal.ts`; `plan()` is `planGoal` in
  `apps/server/src/fleet/goals/goalPlan.ts`; claims, CAS and the four tables are in
  `GoalStore.ts` (migration 086); `GoalController.ts` is the Scheduler source; every touch on a
  thread goes through `GoalWorkerRuntime.ts`. The four tags live where the interface section says,
  with the local-only defaults in `apps/server/src/fleet/defaults.ts`.
- Workers are observed by reading thread status on each pass. The `controller` watch kind and
  `LaunchWatchService.snapshot` are not built: local workers are launched without a watch, and
  launch-watch reports do not move `nextReconcileAt` yet, so the 60 s cadence is the only trigger.
- An unconfirmed local launch is found by the action id at the end of the worker's title among the
  project's threads, which exist before any watch. A rescheduled attempt is claimed under
  `goal:<id>:s<slot>:a<attempt>:<runId>:reschedule`, one per failed or stalled run.
- Local follow-ups, model switches and interrupts dispatch `message.dispatch` / `run.interrupt`
  directly with the action id as `commandId`, after checking the worker's modes against the
  goal's authority and under `DispatchModeLimit`, because `goat_thread_send` refuses an owner
  whose turn has ended.
- Goal workers are local-only for now. Apply refuses a spec that names a remote host, the
  controller refuses a remote placement before claiming, and the runtime refuses remote launches
  and follow-ups. The remote paths re-read the owner's current mode instead of the goal's stored
  ceiling, find a remote thread only by its title marker, and gate project creation on the worker's
  mode. Each needs a fix before remote workers come back.
- PR state comes from `PullRequestService.checks` for the goal's repo, not thread PR links.
- Goal-owned threads are excluded from `UsageLimitRecoveryWorker` through `GoalThreadOwnership`, so
  the controller resumes them itself: once a run failed with `usage_limit` and its reset time has
  passed, it sends one continue message under `goal:<id>:s<slot>:a<attempt>:<runId>:resume`. A
  paused goal does not resume.
- An attempt replaced after `LAUNCH_GRACE_MS` is not kept as its own record, so a late thread from
  it is not found or interrupted by the goal. Fencing of stale attempts arrives with self-healing.
- Owner authority is re-read right before each action, but not inside the claim transaction, so a
  mode change in that short window is honoured from the next action on.
- `limits.maxTokens` is refused unless null; nothing counts tokens yet.
- Only thread owners are accepted; `owner.kind: "mcp_client"` is in the contract but refused
  (#493). Owners in plan mode are refused because the remote and dispatch paths carry no plan
  ceiling.

## Self-healing

**Now.** `apps/server/src/fleet/health/` implements this section. `Health` and `Rescheduler` are
the tags below; `goat_host_status` returns each host's conditions as the additive `conditions`
field, and `goat_host_cordon`, `goat_host_uncordon`, `goat_host_drain` and `goat_thread_reschedule`
live in `apps/server/src/mcp/toolkits/fleet/`. Cordons persist in `fleet_host_states`. Moving work
off a goal attempt still needs the goal controller: until it lands, drain only cordons and marks the
host Draining, and `goat_thread_reschedule` takes the branch and folder from its caller. Channel
tasks still heal through `ChannelRemoteWorkers.ts`. Moving the replica helpers out of channels waits
for replica capture of goal attempts (#525); `fleet_replicas` already exists for it.

Where the code departs from the text below, and why:

- Sleep on this machine never counts against a host. A gap of two minutes or more in the shared
  Scheduler's ticks, or a suspended power snapshot, drops the failures counted so far and ignores
  failures for the next five minutes, so a Mac waking from sleep makes no host Lost.
- `RescheduleRequest` has three optional fields: `project` (the folder and repository key to find on
  the target), `targetHost` (a person's choice) and `force` (skip only the Lost wait).
- VersionMismatch follows the host status compatibility verdict (#497): it appears only for a
  `degraded` or `incompatible` host, with that verdict as its `reason`, and an `incompatible` host
  takes no work. Different builds that are compatible raise no condition.
- Placement uses `choosePlacement` over Ready, uncordoned hosts until the T3 `Placement` tag lands.
- A request that resumes from a replica is refused with `no_resume_point` until replica capture for
  goal attempts lands; branch and base resumes work.
- A retry after a lost answer finds the launched thread by its title (`Resume <branch>`) on the
  candidate hosts instead of launching again; the attempt branch keeps two launches apart as well.
- `fenceStaleAttempt` interrupts a returning stale attempt with a reason that names the successor.
  It sends no message, since a message would start another turn there.

**Channel tasks.** `ChannelRemoteWorkers.ts` gives a remote launch
`LAUNCH_GRACE_MS = 300000` and `MAX_LAUNCH_ATTEMPTS = 3`, notices an outage after
`OUTAGE_NOTICE_AFTER = 3` failed contacts, and `move` relaunches a task elsewhere but refuses while the
old host still answers (`MOVE_COPY`). `channelReplica.ts` bundles each finished turn's commits and
uncommitted changes into `refs/goat/replicas/<task>/<gen>` and resumes on
`goat/replica/<task>-<gen>`, skipping files over 2 MiB and secret-looking names. Launch watches back
off 30 s → 15 min per host and report one outage per episode after three failures.

**Design (T2, `apps/server/src/fleet/health/`).**

### Host conditions

`HostHealthMonitor` derives conditions from signals that already exist; it adds no new probe
traffic.

| Condition         | True when                                                                                | Effect                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Ready`           | last host status or watch contact succeeded within 3 min                                 | placement allowed                                                                  |
| `Unknown`         | no contact in 3 min (an idle host has no watches)                                        | one `goat_host_status` probe, at most once a minute per host, before placing there |
| `Unreachable`     | ≥ 3 consecutive failed contacts (`OUTAGE_NOTICE_FAILURES`) across watches or host status | placement refused; attempts there are suspect                                      |
| `Lost`            | `Unreachable` for ≥ `hostLostAfterMs` (default 300 s, same as `LAUNCH_GRACE_MS`)         | attempts there may be rescheduled                                                  |
| `Cordoned`        | a person or agent ran `goat_host_cordon`                                                 | placement refused; running work untouched                                          |
| `Draining`        | `goat_host_drain` ran; implies Cordoned                                                  | goal attempts moved after their current run                                        |
| `VersionMismatch` | `markVersionMismatch` flagged it                                                         | warning only, as today                                                             |
| `QuotaExhausted`  | per provider instance: a quota window at 100 % before `resetsAt` (`isExhausted` rule)    | that instance is filtered out on that host                                         |

The 5-minute grace mirrors Kubernetes, which evicts pods from an unreachable node after the default
`tolerationSeconds: 300` ([taints and tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)),
and Nomad's `disconnect.lost_after`, which keeps an allocation `unknown` before replacing it
([disconnect](https://developer.hashicorp.com/nomad/docs/job-specification/disconnect)).

Cordon and drain state persists in `fleet_host_states` (host alias, cordoned, draining, reason, by,
at). Cordon only stops new placement, like `kubectl cordon`; drain also moves goal attempts, but only
between runs, one slot per goal at a time (a fixed `maxUnavailable: 1` in PodDisruptionBudget terms,
[disruptions](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/)). Drain never interrupts a
running turn and never touches threads that no goal owns. `goat_host_uncordon` clears both.

### Thread health

`ThreadStallDetector` classifies one attempt from its status snapshot:

| Health      | Rule                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `healthy`   | run active and `lastActivityAt` within `stallAfterMs` (default 20 min), or the thread is idle between runs |
| `waiting`   | `pendingRequest` is set or a run is queued; never a stall, the goal reports `NeedsHuman`                   |
| `stalled`   | run `running` and no activity for `stallAfterMs`                                                           |
| `host_lost` | the attempt's host is `Lost`                                                                               |
| `failed`    | latest run terminal with `failed`; carries `lastErrorClass`                                                |
| `unknown`   | no snapshot yet, or the host is `Unreachable` but not `Lost`; no action                                    |

Temporal's activity heartbeat timeout is the same idea: no heartbeat within the window fails the
attempt and the retry policy decides what follows
([detecting activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures)). Our
heartbeat is `lastActivityAt`, which any provider event moves. A remote that predates
`lastActivityAt` reports `unknown`, and stall detection stays off for it.

### Reschedule decision

| Observation                                                    | First action                                    | If it repeats                           |
| -------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| `stalled`                                                      | interrupt, then steer "Continue; report status" | reschedule (`stalled`)                  |
| `host_lost`                                                    | reschedule (`host_unreachable`)                 | —                                       |
| `failed` with `usage_limit`/`provider_error`/`transport_error` | `Fallback.next` (T3)                            | reschedule after the chain is exhausted |
| `failed` with `permission_error`/`validation_error`            | no retry; goal `Blocked` with the error         | —                                       |
| `failed` with `unknown`                                        | reschedule (`failed`)                           | —                                       |
| host `Draining`, attempt idle between runs                     | reschedule (`drain`)                            | —                                       |
| launch not visible after `LAUNCH_GRACE_MS`                     | count one attempt, place again                  | `Blocked` after `maxAttemptsPerWorker`  |

Retry budget: `maxAttemptsPerWorker` (default 3, counting the first launch, as Temporal's
`maximumAttempts` does, [RetryPolicy](https://typescript.temporal.io/api/interfaces/common.RetryPolicy)),
and a goal-wide cap of `2 × maxWorkers` reschedules per 24 h, the sliding-window shape of Nomad's
`reschedule { attempts, interval }` ([reschedule](https://developer.hashicorp.com/nomad/docs/job-specification/reschedule)).
Delays between attempts use the same 30 s → 15 min exponential curve. Errors that a retry cannot fix
(permission, validation) are not retried, like Temporal's `nonRetryableErrorTypes`.

### Resume from the branch or a replica

`Rescheduler.reschedule(ref, reason)` generalises the channel `move`:

1. Pick the resume point by commit, not by kind: among the attempt's pushed branch tip
   (`git ls-remote` from the parent) and the newest replica captured after a finished turn, take the
   one that contains the other; when neither does, take the replica, which also holds uncommitted
   changes, and record both OIDs. With neither, start from the goal's `baseRef` (recorded as
   `ResumedFromBase`). A replica is imported into the destination repository and verified by OID
   before launch, as `ChannelRemoteWorkers.ts` does for channel moves; the launch then starts from a
   local ref that is known to exist there.
2. Place the next attempt with `Placement.place`, excluding the old host unless it is the only
   candidate and is `Ready`.
3. Launch with workspace `worktree{ baseRef: <resume point>, branch: <prefix>-s<slot>-a<attempt+1>, startFromOrigin }`
   (`SshLaunchWorkspace` in `packages/contracts/src/orchestratorMcp.ts`). The prompt includes the old
   thread id, host, branch and the reason.
4. Mark the old attempt `superseded`.

Moving work off a host that still answers is allowed only after the old attempt is confirmed
interrupted: `stalled`, `drain` and `fallback_relaunch` interrupt first and move on the next
reconcile. `host_unreachable` requires the host to be `Lost` and is refused with
`host_still_answers` once it answers again. `manual` follows the rule for the observed state, and
`force` skips only the `Lost` wait.

Replica capture moves from `channels/channelReplica.ts` into `apps/server/src/fleet/health/replica.ts`
keyed by `(ownerKey, generation)` instead of channel task id. The channel module re-exports it, so
the channels code does not change in this phase.

### Fencing

The slot's `attempt` number is the fencing token. It limits damage; it cannot stop a disconnected
attempt that keeps running. That attempt may still run tests, call external services, push its own
branch and open a PR until its host comes back. A remote lease that the worker must renew before each
side effect would close this, but older hosts cannot honour it, so this design accepts the risk,
bounds it, and lets a goal opt out with `spec.workers.onHostLost: "wait"` (default `"reschedule"`).
With `"wait"` a lost host makes the goal `Blocked` with reason `HostLost` and a person decides with
`goat_thread_reschedule`. Two rules bound the risk:

- Every attempt gets its own branch (`-a<attempt>`). Two attempts can never push to the same
  branch, so a host that comes back cannot overwrite the successor's commits.
- Only the current attempt counts. When a superseded attempt's host comes back, the controller
  interrupts that thread once (id `goal:<id>:s<slot>:a<old>:interrupt`), records a `StaleAttempt`
  event, and ignores its PRs and results. Its branch is left for a person to compare.

A PR opened by a stale attempt is reported in the goal's events, never merged or closed by the
controller.

## Resources and placement

**Now.** `choosePlacement` in `apps/server/src/channels/channelPlacement.ts` is a pure scorer: the
busiest quota window counts, an account with no windows counts as `UNKNOWN_QUOTA_PERCENT = 35`,
each running task adds `LOAD_PENALTY = 40`, exhausted candidates are skipped while another can run,
and ties keep the configured choice. Host status reports `threads{running,waiting,queued}` and quota
windows refreshed every 60 s (`HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS`). GOAT Bot caps a requester at
four items (#483). Nothing caps threads per host.

**Proposed (T3, `apps/server/src/fleet/resources/`).**

Limits live in server settings (`packages/contracts/src/settings.ts`), all optional, all off by default:

```ts
fleet: {
  controllerEnabled: boolean; // default false: the kill switch for goals
  maxRunningThreads: number | null; // global, counted from host status, default null
  hosts: Record<
    string /* alias or "local" */,
    {
      maxThreads: number | null; // default null (no cap)
      allowGoals: boolean; // default true
    }
  >;
  goalDefaults: {
    maxWorkers: 3;
    maxAttemptsPerWorker: 3;
    maxTurns: 40;
    maxWallClockMs: 86_400_000;
  }
  stallAfterMs: 1_200_000;
  hostLostAfterMs: 300_000;
  fallbackChains: Record<string, FallbackChain>;
  defaultFallbackChain: string | null; // used by goals that do not name one; default null
}
```

Requests and limits map like this: a goal worker requests one thread slot on one provider instance;
`hosts[h].maxThreads` and `maxRunningThreads` are limits checked at placement against running plus
queued threads from host status (all threads, not only goal threads, because a person's own work
uses the same machine and account). Goal limits (`maxWorkers`, `maxTurns`, `maxTokens`,
`maxWallClockMs`) act like a namespace ResourceQuota for one goal
([resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)), and `goalDefaults` act
like a LimitRange that fills in what a goal omits ([limit range](https://kubernetes.io/docs/concepts/policy/limit-range/)).
Tokens are counted only where a provider reports usage; turns always count.

Caps are enforced for goal work and are advisory for people. Goal placements reserve a slot in the
same transaction as their action claim, and the count is running plus queued threads from host
status plus unsettled goal reservations, so two goals cannot both take the last slot. A person
launching a thread by hand is never refused by a goal cap; that thread simply counts against the
next goal placement.

Goal budgets are hard for new work and soft for work in flight. Once a budget is spent, every claim
for a launch, steer, follow-up, fallback hop or reschedule is refused, and the turn already running
finishes. Goal-owned threads are excluded from `UsageLimitRecoveryWorker` auto-resume (a pure filter
on the owner key), so a paused, blocked or over-budget goal is not continued behind its back; the
goal resumes them through its own claims instead.

`PlacementScheduler.place` follows the scheduler framework's filter-then-score shape
([scheduling framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)):

1. **Filter** each (host, provider instance) candidate. Refuse when the host is not `Ready`, is
   `Cordoned`, is outside the goal's `hostSelector`, lacks the provider instance or the project, is at
   `maxThreads`, or when the global cap is reached. Each refusal keeps a reason.
2. **Score** the survivors with the existing `choosePlacement`. It moves from
   `apps/server/src/channels/channelPlacement.ts` to
   `apps/server/src/fleet/resources/placementScore.ts`; the channel module re-exports it unchanged.
   There is one scorer. The scorer file is `placementScore.ts` rather than `placement.ts`: on a
   case-insensitive filesystem that name is the same file as `Placement.ts`.
3. Return `Placed` or `Refused` with the per-candidate reasons, which become the goal's `Blocked`
   condition message.

There is no preemption. A goal never stops someone's thread to make room; it waits, like a pod with
`preemptionPolicy: Never` ([priority and preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)).

**Now (T3).** `fleet` settings and `Placement` (`apps/server/src/fleet/resources/Placement.ts`)
ship as above. The filter is `placementRules.ts`. `choosePlacement` stays in
`channelPlacement.ts` and is imported rather than moved while channel work is in flight; it is
still the only scorer. The filter cannot see projects on a host or cordons yet: missing projects
surface at launch, and the cordon set is an input that T2's `Health` fills. Goal reservations
belong to T1's action claims and are not counted here. Service keys follow the repository's
deterministic-key rule (`goat/fleet/resources/Placement`), not the shorter names above.

## Fallback chains

**Now.** No fallback chain exists in contracts or settings. A thread that fails with
`lastErrorClass = "usage_limit"` and a reset time is armed and later resumed by
`limitRecoveryCommand` (`UsageLimitRecoveryWorker.ts`) when `autoResumeLimitedThreads` is on.
`ProviderSwitchServiceV2.plan` (`ProviderSwitchService.ts`) computes whether a model change on an
existing thread changes the instance or only the model and what session transition it needs, and
`ContextHandoffService.ts` carries the conversation across a provider change.

**Proposed (T3).**

```ts
type FallbackChain = {
  steps: ReadonlyArray<{
    instanceId: ProviderInstanceId;
    model: string;
    options?: ModelSelectionOptions;
  }>;
  on: ReadonlyArray<"usage_limit" | "provider_error" | "transport_error" | "unavailable">; // default ["usage_limit"]
  maxHops: number; // default steps.length - 1
  cooldownMs: number; // a failed step is skipped for this long, default 15 min
  scope: "goals" | "goals_and_threads"; // default "goals"
};
```

An example a user could configure (nothing ships enabled):
`codex/anthropic/claude-opus-5-5 → codex/anthropic2/claude-opus-5-5 → codex/gpt-6.1-sol → claudeAgent/<model>`.
Chains only choose a `ModelSelection`. They never edit provider homes, `~/.codex` or OpenCodex
routing; `anthropic` and `anthropic2` are already two models of the `codex` instance.

`unavailable` is not a provider failure class today. It means the step's instance is disabled,
missing on the chosen host, or `QuotaExhausted` there before a turn starts, and is checked during
placement.

`Fallback.next(selection, failureClass, tried)` walks the chain from the current step, skipping steps in
cooldown, already tried in this run, or unavailable on the host, and returns one of:

- `SwitchInThread{selection}` when `ProviderSwitchServiceV2.plan` accepts the target for this
  thread. The controller dispatches the model change plus "Continue where you left off." with id
  `goal:...:fallback:<hop>`; a cross-instance change goes through the existing context handoff.
- `Relaunch{selection}` when the switch is not possible on this thread or host (for example a
  driver the remote lacks). The Rescheduler resumes from the branch or replica with the new
  selection, as in self-healing.
- `Exhausted`.

This is the router model of LiteLLM (ordered `fallbacks` plus `cooldown_time` for a failing
deployment, [reliability](https://docs.litellm.ai/docs/proxy/reliability)) and OpenRouter (ordered `models`,
the response names the model that served it,
[model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)), applied per turn instead
of per request because our unit of work is a turn with tool state.

Interaction with `UsageLimitRecoveryWorker`: fallback first if configured, otherwise wait for the
reset. Scheduler sources run concurrently, so ordering cannot prevent a race; ownership does. Each
failed run has exactly one owner, decided by a pure rule both paths evaluate the same way:

- Goal-owned thread: the goal controller owns it. The recovery worker skips it. When the chain is
  exhausted, the controller dispatches the wait-for-reset continuation itself through a claim.
- Ordinary thread with an applicable chain (`scope = "goals_and_threads"`) whose next step is
  available: the fallback path owns it, implemented inside the recovery worker's sweep as one more
  branch of `limitRecoveryCommand` so a single source decides one command per run.
- Anything else: the recovery worker, exactly as today.

There is no separate fallback worker. The default (no chain) leaves ordinary threads unchanged.

Each hop is recorded on the thread as a system notice ("Switched to gpt-6.1-sol after usage limit on
anthropic/claude-opus-5-5") so the user sees why the model changed.

**Now (T3).** `Fallback` (`apps/server/src/fleet/resources/Fallback.ts`) implements `next` and
`reportFailure` as above, and `continueThread` is the recovery sweep's branch for ordinary
threads. A thread's earlier hops are read from the failed runs at the end of its history, so a
restart finds the same next step and replays the same command ids instead of skipping one. When
a chain covers threads, the sweep reads unarmed usage-limit failures even with auto-resume off;
arming still follows the user's settings. `GoalThreadOwnership` is the owner filter: it reports
no goal threads until the goal controller provides it.

## Interfaces between T1, T2 and T3

T1 depends on T2 and T3 through these `Context.Service` tags so tests can supply bounded
implementations without replacing the controller. `apps/server/src/fleet/defaults.ts` retains
only a refusing rescheduler for local goal tests; it is not the server's health implementation.
The server composes health and rescheduling in `fleet/health/layer.ts`, with placement supplied
by `fleet/resources`. Wiring these layers does not by itself authorize remote goal execution:
the worker still enforces its remote authority and durable-dispatch prerequisites (#575).

```ts
// apps/server/src/fleet/resources/Placement.ts (T3)
export interface PlacementRequest {
  readonly owner: FleetOwnerKey; // "goal:<id>" or "thread:<id>"
  readonly modelSelection: ModelSelection;
  readonly fallbackChain: string | null;
  readonly hostSelector: HostSelector;
  readonly project: { host: string | null; projectId: ProjectId | null; cwd: string | null };
  readonly avoidHosts: ReadonlyArray<string | null>;
}
export type PlacementResult =
  | {
      readonly _tag: "Placed";
      readonly host: string | null;
      readonly modelSelection: ModelSelection;
      readonly reason: string | undefined;
    }
  | {
      readonly _tag: "Refused";
      readonly reasons: ReadonlyArray<{ host: string | null; reason: PlacementRefusal }>;
    };
export class Placement extends Context.Service<
  Placement,
  {
    readonly place: (request: PlacementRequest) => Effect.Effect<PlacementResult>;
    readonly status: Effect.Effect<SchedulerStatus>; // for goat_scheduler_status
  }
>()("goat/fleet/Placement") {}

// apps/server/src/fleet/health/Health.ts (T2)
export type HostConditionSet = {
  readonly host: string | null;
  readonly conditions: ReadonlyArray<HostCondition>;
  readonly observedAt: IsoDateTime;
};
export type ThreadHealth =
  | { readonly _tag: "healthy" | "waiting" | "unknown" }
  | { readonly _tag: "stalled"; readonly idleMs: number }
  | { readonly _tag: "host_lost"; readonly since: IsoDateTime }
  | {
      readonly _tag: "failed";
      readonly failureClass: OrchestrationV2ProviderFailureClass;
      readonly runId: RunId;
    };
export interface FleetThreadRef {
  readonly host: string | null;
  readonly threadId: ThreadId;
  readonly watchId: string | null;
}
export class Health extends Context.Service<
  Health,
  {
    readonly hostCondition: (host: string | null) => Effect.Effect<HostConditionSet>;
    readonly threadHealth: (ref: FleetThreadRef) => Effect.Effect<ThreadHealth>;
  }
>()("goat/fleet/Health") {}

// apps/server/src/fleet/health/Rescheduler.ts (T2)
export type RescheduleReason =
  "stalled" | "host_unreachable" | "failed" | "drain" | "fallback_relaunch" | "manual";
export interface RescheduleRequest {
  readonly ref: FleetThreadRef;
  readonly owner: FleetOwnerKey;
  readonly attempt: number; // fencing token of the attempt being replaced
  readonly reason: RescheduleReason;
  readonly modelSelection: ModelSelection; // a fallback relaunch passes the new one
  readonly workspace: { baseRef: string; branch: string; startFromOrigin: boolean };
  readonly previousBranch: string | null; // tip read with git ls-remote
  readonly replica: { ref: string; commitOid: string } | null; // imported at the destination before launch
  readonly prompt: string;
  readonly runtimeMode: RuntimeMode; // already clamped to the owner's ceiling
  readonly clientRequestId: string; // goal:<id>:s<slot>:a<attempt+1>:launch
}
export type RescheduleResult =
  | {
      readonly _tag: "Rescheduled";
      readonly host: string | null;
      readonly threadId: ThreadId;
      readonly branch: string;
      readonly resumedFrom: "branch" | "replica" | "base";
    }
  | {
      readonly _tag: "Refused";
      readonly reason:
        "no_capacity" | "host_still_answers" | "budget" | "no_resume_point" | "unsupported_remote";
      readonly message: string;
    };
export class Rescheduler extends Context.Service<
  Rescheduler,
  {
    readonly reschedule: (request: RescheduleRequest) => Effect.Effect<RescheduleResult>;
  }
>()("goat/fleet/Rescheduler") {}

// apps/server/src/fleet/resources/Fallback.ts (T3)
export type FallbackFailure = OrchestrationV2ProviderFailureClass | "unavailable";
export type FallbackStep =
  | { readonly _tag: "SwitchInThread"; readonly selection: ModelSelection; readonly hop: number }
  | { readonly _tag: "Relaunch"; readonly selection: ModelSelection; readonly hop: number }
  | { readonly _tag: "Exhausted"; readonly reason: string };
export class Fallback extends Context.Service<
  Fallback,
  {
    readonly next: (input: {
      readonly chain: string | null;
      readonly selection: ModelSelection;
      readonly failure: FallbackFailure;
      readonly tried: ReadonlyArray<ModelSelection>;
      readonly host: string | null;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<FallbackStep>;
    readonly reportFailure: (
      selection: ModelSelection,
      failure: FallbackFailure,
    ) => Effect.Effect<void>; // starts cooldown
  }
>()("goat/fleet/Fallback") {}
```

Shared value types (`FleetOwnerKey`, `HostSelector`, `HostCondition`, `PlacementRefusal`,
`SchedulerStatus`, `FallbackChain`) live in contracts: owner keys and selectors in
`fleetGoal.ts` (T1), host conditions in `fleetHealth.ts` (T2), placement, scheduler status and
fallback chains in `fleetResources.ts` (T3). Whoever merges second rebases onto the first; the
types above are the agreement.

## Persistence

**Now.** SQLite migrations live in `apps/server/src/persistence/Migrations/` and are registered in
`apps/server/src/persistence/Migrations.ts`. Launch
watches persist in `thread-launch-watches.json`.

**Proposed.** Goals are control-plane rows outside the orchestration event stream. A goal is not
thread-scoped, the orchestrator decides thread events without I/O, and goal actions are already
ordinary commands (launch, message dispatch, interrupt) that the orchestrator records on the target
threads. Keeping goals in their own tables avoids new orchestration events, projections and client
contracts.

| Table                | Owner | Columns                                                                                                                                                                   |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet_goals`        | T1    | `id` PK, `owner_json`, `spec_json`, `generation`, `status_json`, `observed_generation`, `phase`, `next_reconcile_at`, `deletion_requested_at`, `created_at`, `updated_at` |
| `fleet_goal_workers` | T1    | `(goal_id, slot)` PK, `attempt`, `host`, `thread_id`, `watch_id`, `branch`, `model_json`, `state`, `launch_client_request_id`, `tried_json`, `updated_at`                 |
| `fleet_goal_events`  | T1    | `goal_id`, `seq`, `at`, `type`, `reason`, `message`, `slot`, `attempt`, `action_id`; trimmed to 200 per goal                                                              |
| `fleet_goal_actions` | T1    | `action_id` PK, `goal_id`, `generation`, `kind`, `host`, `reserved_slot`, `claimed_at`, `settled_at`, `outcome`; settled rows trimmed after 7 days                        |
| `fleet_host_states`  | T2    | `host` PK (`"local"` for this machine), `cordoned`, `draining`, `reason`, `changed_by`, `changed_at`                                                                      |
| `fleet_replicas`     | T2    | `(owner_key, generation)` PK, `ref`, `file`, `commit_oid`, `captured_at`                                                                                                  |

Status writes compare `generation` so a status computed for an old spec never overwrites a newer
one. Fallback cooldowns are in memory: losing them on restart only retries a step early. T3 adds no
table; its state is settings. Each of T1 and T2 adds one migration and takes the next free number at
rebase (085 and 086 at the time of writing), updating `Migrations.test.ts`.

## Agent and client surface

**Proposed.** All tools are entries in `packages/contracts/src/agentSurface/registry.ts` with toolkits
under `apps/server/src/mcp/toolkits/fleet/`, follow `resource.verb` naming (ADR-0007), and return the
`ok | error | needs_human` envelope from [agent surface](./agent-surface.md). Each handler decodes
input, calls one service method, and maps errors.

| Tool                                                  | Effect       | Owner | Notes                                                                              |
| ----------------------------------------------------- | ------------ | ----- | ---------------------------------------------------------------------------------- |
| `goat_goal_apply`                                     | write        | T1    | create or update by id; spec change bumps generation; supports `dryRun`            |
| `goat_goal_get`                                       | read         | T1    | spec, status, conditions, last 20 events                                           |
| `goat_goal_list`                                      | read         | T1    | goals the caller owns                                                              |
| `goat_goal_pause` / `goat_goal_resume`                | write        | T1    | pause stops actions, never threads                                                 |
| `goat_goal_delete`                                    | destructive  | T1    | finalizer path above; work is kept                                                 |
| `goat_host_cordon` / `goat_host_uncordon`             | write        | T2    | persisted per host                                                                 |
| `goat_host_drain`                                     | write        | T2    | cordon plus between-run moves of goal attempts                                     |
| `goat_thread_reschedule`                              | write        | T2    | manual reschedule of a goal attempt; refuses while the host answers unless `force` |
| `goat_scheduler_status`                               | read         | T3    | per host: conditions, limits, counts, quota windows, last refusals                 |
| `goat_fallback_chain_get` / `goat_fallback_chain_set` | read / write | T3    | settings-backed; set validates instances and models                                |

A CLI follows from the registry later. Cordon, drain, chain and limit settings also need a
Settings entry on web and desktop and a read-only view on mobile; that is a later phase.

## Authority and safety

- **No new authority.** A goal records its creator's runtime mode at apply time as
  `runtimeModeCeiling`. Every worker is launched, steered and interrupted at
  `min(spec.workers.runtimeMode, ceiling)`, through the same watch ceiling remote reads already
  honour. Remote launches also pass the same memory grant ceiling `SshRemoteDispatch.ts` passes for
  the creator today. An update by the owner can lower the ceiling; the controller never raises it.
- **Authority is re-checked, not remembered.** A stored ceiling is only an upper bound. Every action
  claim re-checks that the owner still exists and still holds that mode now: an owner thread must
  exist and not be archived, and an MCP owner must still have its client grant. When the check fails
  the claim is refused and the goal becomes `Blocked` with reason `OwnerAuthorityLost`; running
  threads are left alone.
- **Whose subscription.** Goals in phases 1–3 can be created only by the environment owner (a
  thread in that environment or an owner-scoped MCP client). A goal that GOAT Bot creates for a
  visitor must carry that visitor's allowed instances as its host selector and model list; placement
  refuses anything else. Visitor work never falls back onto the owner's accounts.
- **Opt-in.** `fleet.controllerEnabled` defaults to false; no fallback chain, host cap or global cap
  exists until someone sets one. Upgrading changes no behavior.
- **Kill switch.** Turning `controllerEnabled` off stops every goal action on the next tick without
  touching running threads. `goat_goal_pause` does the same for one goal.
- **Conservative budgets.** Defaults are 3 workers, 3 attempts per worker, 40 turns and 24 h per
  goal. A goal at any budget becomes `Blocked` and asks for a person; it never extends its own
  budget.
- **Never destructive by default.** The controller never deletes threads, worktrees, branches or
  PRs, never merges, and never force-pushes. Merging stays a human or separately authorized step.

## Observability

Goal status and events are the primary record, readable through `goat_goal_get`. Each action also
logs one structured line (`fleet.goal.action`, `fleet.host.condition`, `fleet.fallback.hop`)
with the action id. The Fleet tab can later read goal phase and host conditions through the same
service methods; this design adds no UI and touches no Fleet web files, so it does not overlap the
open Fleet HUD work (#470).

## GOAT Bot

**Now.** GOAT Bot keeps work items, a per-requester cap and stall handling inside
`apps/server/src/channels/` (see [GOAT Bot behavior](./goat-bot-behavior-spec.md)). Another thread is
changing that code now (spec gaps 4–7: work items vs runs, stop-all, per-requester cap, subagent
approvals; #483 landed the cap and stop).

**Proposed, after T1–T3.** The bot creates and updates goals through `GoalService` instead of
looping by hand: one work item becomes one goal (or one slot of a shared goal), "stop" becomes pause
or delete, and the per-requester cap becomes the goal's `maxWorkers` within the requester's quota.
Channel remote workers move onto `Rescheduler` and the shared replica module. None of this changes
channels code in phases 1–3; it is a separate PR once the bot thread has merged.

## Rollout and compatibility

- Everything is off until enabled. Old clients see nothing new; the tools appear in the registry
  and old MCP clients ignore them.
- Mixed host versions keep working. A host that answers `goat_host_status` as unsupported
  (`isUnsupportedHostStatusMessage`) has no quota or load data: it scores as unknown and gets no
  `QuotaExhausted` condition. A host without `lastActivityAt` in thread status gets no stall
  detection. A host whose SSH launch lacks `existing_worktree` or worktree launches is filtered out
  for reschedules with reason `unsupported_remote`. Nothing is required of a remote beyond what
  `goat_ssh_thread_launch` and `goat_thread_status` need today.
- `VersionMismatch` stays a warning; it never blocks placement.
- Windows hosts follow whatever `SshRemoteDispatch` supports; the design adds no shell of its own
  beyond the replica capture already used for channels.

## Test plan

Each piece is a pure decision function plus a thin service, tested like `limitRecoveryCommand`:

- T1: `plan()` table tests (every row of the controller rules, budgets, pause, delete, spec
  shrink, stale attempt); idempotency (running the same tick twice dispatches nothing new; a crash
  between launch and status write relaunches nothing); generation CAS; migration test.
- T2: host condition derivation from outage and status fixtures; stall classification boundaries;
  resume point chosen by commit containment and imported before launch; fencing interrupts a
  returning stale attempt exactly once; a host that answers is never moved off without a confirmed
  interrupt; drain moves one slot at a time and never mid-run; old status payloads without the new
  fields decode as `unknown`.
- T3: filter reasons, score parity with today's `choosePlacement` tests (moved unchanged); chain walk
  with cooldown and `tried`; recovery interplay (fallback dispatched → `limitRecoveryCommand` returns
  null; chain exhausted → recovery arms as today); settings decode defaults.
- Effects: drain `OrchestrationEffectWorkerV2.drain` or await persisted events; no sleeps.
- One integrated pass per phase on a dev server with an isolated home: one local goal of two
  workers to completion, then one SSH host taken offline mid-run.

## Phased PR plan

Each PR stays under about 20 files and ships off by default.

| PR  | Thread | Branch                            | Scope                                                                                                                   |
| --- | ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 0   | T0     | `docs/agentic-k8s-design`         | this design and ADR-0016–0018                                                                                           |
| 1a  | T1     | `feat/agentic-goals-controller`   | `packages/contracts/src/fleetGoal.ts`, `GoalStore`, migration, default layers for Placement/Health/Rescheduler/Fallback |
| 1b  | T1     | same                              | `GoalController` on the Scheduler, `plan()`, actions, `LaunchWatchService.snapshot`                                     |
| 1c  | T1     | same                              | MCP `goat_goal_*` and registry entries                                                                                  |
| 2a  | T2     | `feat/agentic-self-healing`       | `packages/contracts/src/fleetHealth.ts`, `HostHealthMonitor`, `fleet_host_states`, cordon/uncordon/drain                |
| 2b  | T2     | same                              | `ThreadStallDetector`, `Rescheduler`, replica module moved from channels with a re-export, fencing                      |
| 2c  | T2     | same                              | MCP `goat_host_cordon`/`uncordon`/`drain`, `goat_thread_reschedule`                                                     |
| 3a  | T3     | `feat/agentic-resources-fallback` | `packages/contracts/src/fleetResources.ts`, settings, `PlacementScheduler` with `choosePlacement` moved and re-exported |
| 3b  | T3     | same                              | `Fallback`, fallback branch inside the recovery sweep, goal-thread exclusion from auto-resume                           |
| 3c  | T3     | same                              | MCP `goat_scheduler_status`, `goat_fallback_chain_get`/`set`                                                            |
| 4   | later  | —                                 | Settings UI for limits and chains, read-only Fleet goal view, mobile read-only                                          |
| 5   | later  | —                                 | GOAT Bot creates goals; channel remote workers use `Rescheduler`                                                        |

A thread may merge its three PRs as one if each stays reviewable; the split is a ceiling, not a
requirement.

## Decisions made without a human

- **Goals live outside the event stream** (tables above). Event-sourcing them would add projections
  and client contracts for state no client renders yet.
- **One owning environment, no leader election.** Goals never span environments in this design.
- **Stall threshold 20 min, lost-host grace 5 min, 3 attempts.** Agent turns often think for
  minutes; 20 min avoids interrupting slow but live work. 5 min matches existing launch grace.
- **Fallback before wait-for-reset**, as Jun asked, but only for goals unless a chain opts into
  ordinary threads.
- **Attempt-per-branch fencing** instead of a remote lease: it needs nothing new from older hosts.
  It bounds a disconnected attempt's damage but does not stop it; goals can opt out with
  `onHostLost: "wait"`.
- **Claims before side effects.** Every action is claimed in one transaction that re-reads
  generation, pause, deletion, budget and authority. An unclear launch moves to the next attempt
  instead of being resent.
- **One owner per failed run.** Fallback lives inside the usage-limit recovery sweep for ordinary
  threads, and goal threads belong to the controller, so no two sources act on one run.
- **T1 ships local-only.** Remote goals wait for real placement and health.
- **No preemption and no auto-merge.**
