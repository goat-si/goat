import { assert, describe, expect, it } from "@effect/vitest";
import {
  type ChannelTask,
  ChannelTaskEvent,
  ChannelQuestionId,
  type ChannelWorkerObservation,
  RuntimeRequestId,
  RunId,
  ProjectId,
  EnvironmentId,
  ProviderInstanceId,
  type RuntimeMode,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  ChannelRemoteWorkers,
  OUTAGE_NOTICE_AFTER,
  REMOTE_COPY,
  REMOTE_SETTLE_WAIT_MS,
  type RemoteWorkerState,
  layer as remoteWorkersLayer,
} from "./ChannelRemoteWorkers.ts";
import { remoteBranchFor, remoteCorrelationFor } from "./channelIds.ts";
import { resumeBranchFor } from "./channelReplica.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import {
  botMessages,
  latestCard,
  goatInput,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  resultsTo,
  rpcContext,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import {
  REPLICA_BYTES,
  REPLICA_COMMIT,
  REPLICA_OUTPUT,
  RemoteMachine,
  correlationOf,
  remoteScript,
  replicaOutput,
  settle,
  sha256,
  until,
} from "./testing/RemoteMachine.ts";

/**
 * Tasks on another machine. The other machine is a fake GOAT reached over a fake SSH dispatch:
 * it keeps report bindings (one per correlation id, stored before the thread exists, like the
 * real goat_thread_launch), the reports its worker files with goat_origin_report, and its runs.
 * Tests drive the worker's side and the network; the channel side is the real core.
 */

const remoteHarness = () => {
  const machine = new RemoteMachine();
  const harness = makeHarness({ sshRemote: machine.layer });
  harness.script.current = remoteScript;
  return { machine, harness };
};

const readState = (taskId: ChannelTask["taskId"]) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const json = yield* ledger.getRemoteWorker(taskId);
    return JSON.parse(json ?? "{}") as RemoteWorkerState;
  });

const decodeTaskEventJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ChannelTaskEvent));

/** How many times the task said a machine it left is back; the notice lives on its progress line. */
const staleNotices = (host: string) =>
  Effect.gen(function* () {
    const task = yield* onlyTask;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly event_json: string }>`
      SELECT event_json FROM channel_task_events
      WHERE task_id = ${task.taskId} AND type = 'task.progress'
    `;
    let count = 0;
    for (const row of rows) {
      const event = yield* decodeTaskEventJson(row.event_json);
      if (
        event.type === "task.progress" &&
        event.payload.summary === REMOTE_COPY.staleMachineBack(host)
      ) {
        count += 1;
      }
    }
    return count;
  });

/** Read the persisted event after until has driven the task to its expected state. */
const readTaskEvent = (task: ChannelTask, type: ChannelTaskEvent["type"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly event_json: string }>`
      SELECT event_json FROM channel_task_events
      WHERE task_id = ${task.taskId} AND type = ${type}
      ORDER BY sequence DESC LIMIT 1
    `;
    assert.lengthOf(rows, 1);
    return yield* decodeTaskEventJson(rows[0]!.event_json);
  });

/** Observes committed SQLite writes without replacing their behavior or polling the ledger. */
const taskWriteMilestones = Effect.fn("test.channelWriteMilestones")(function* (
  taskId?: ChannelTask["taskId"],
) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const completedForwards = new Set<number>();
  const forwardListeners = new Map<number, Deferred.Deferred<void>>();
  const listeners = new Set<{
    readonly check: (task: ChannelTask, state: RemoteWorkerState | undefined) => boolean;
    readonly done: Deferred.Deferred<ChannelTask>;
  }>();
  const notify = Effect.gen(function* () {
    if (listeners.size === 0) return;
    const task = taskId === undefined ? yield* onlyTask : (yield* ledger.getTask(taskId))?.task;
    if (task === undefined) return;
    const json = yield* ledger.getRemoteWorker(task.taskId);
    const state = json === undefined ? undefined : (JSON.parse(json) as RemoteWorkerState);
    for (const listener of listeners) {
      if (!listener.check(task, state)) continue;
      listeners.delete(listener);
      yield* Deferred.succeed(listener.done, task);
    }
  }).pipe(Effect.provideService(ChannelLedger.ChannelLedger, ledger));
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      // These two methods stay live; the wrappers only signal after their writes commit.
      const observed: {
        updateRemoteWorker: typeof ledger.updateRemoteWorker;
        applyTaskEvent: typeof ledger.applyTaskEvent;
        completeForward: typeof ledger.completeForward;
      } = ledger;
      const update = observed.updateRemoteWorker;
      const apply = observed.applyTaskEvent;
      const complete = observed.completeForward;
      observed.completeForward = (input) =>
        complete(input).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              completedForwards.add(input.sequence);
              const done = forwardListeners.get(input.sequence);
              if (done !== undefined) yield* Deferred.succeed(done, undefined);
            }),
          ),
        );
      observed.updateRemoteWorker = (input) => update(input).pipe(Effect.tap(() => notify));
      observed.applyTaskEvent = (input) => apply(input).pipe(Effect.tap(() => notify));
      return () => {
        observed.updateRemoteWorker = update;
        observed.applyTaskEvent = apply;
        observed.completeForward = complete;
      };
    }),
    (restore) => Effect.sync(restore),
  );
  return {
    waitForForward: (sequence: number) =>
      Effect.gen(function* () {
        if (completedForwards.has(sequence)) return;
        const done = yield* Deferred.make<void>();
        forwardListeners.set(sequence, done);
        yield* Deferred.await(done);
      }),
    waitFor: (check: (task: ChannelTask, state: RemoteWorkerState | undefined) => boolean) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<ChannelTask>();
        listeners.add({ check, done });
        yield* notify;
        return yield* Deferred.await(done);
      }),
  };
});

const channelWriteMilestones = taskWriteMilestones();

type ChannelWriteMilestones = Effect.Success<typeof channelWriteMilestones>;

const failoverHarness = () => {
  const { machine, harness } = remoteHarness();
  const destination = new RemoteMachine();
  destination.host = "mac-mini";
  destination.projects = destination.projects.map((project) => ({
    ...project,
    workspaceRoot: "/srv/goat",
  }));
  machine.peers.push(destination);
  machine.captureOutput = REPLICA_OUTPUT;
  return { machine, destination, harness };
};

const startFailoverTask = (writes: ChannelWriteMilestones, machine: RemoteMachine, local = false) =>
  Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    yield* gateway.ingest(
      goatInput(
        local ? "do: continue the build" : "do@mac-studio: continue the build",
        "failover-start",
      ),
      rpcContext,
    );
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
    const task = yield* writes.waitFor((task) => task.status === "running");
    if (!local) yield* Deferred.await(machine.waitIdle);
    return task;
  });

const replicaFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join((yield* ServerConfig.ServerConfig).stateDir, "channel-replicas");
  return (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
});

/** Drive precisely the observer's failed-wait/backoff milestones, then its durable notice. */
const noticeMachineOutage = (machine: RemoteMachine, writes: ChannelWriteMilestones) =>
  Effect.gen(function* () {
    const previousFailures = machine.unreachableWaitCount;
    machine.down = true;
    for (let attempt = 0; attempt < OUTAGE_NOTICE_AFTER; attempt += 1) {
      const failed = machine.waitUnavailable;
      if (attempt === 0) machine.timeoutWait();
      else yield* TestClock.adjust(Duration.seconds(5 * 2 ** (attempt - 1)));
      yield* Deferred.await(failed);
    }
    assert.strictEqual(machine.unreachableWaitCount - previousFailures, OUTAGE_NOTICE_AFTER);
    return yield* writes.waitFor(
      (task, state) =>
        state?.outageNoticed === true && task.resultSummary === REMOTE_COPY.outage(machine.host),
    );
  });

const prepareFailover = (machine: RemoteMachine, writes: ChannelWriteMilestones) =>
  Effect.gen(function* () {
    const running = yield* startFailoverTask(writes, machine);
    const correlationId = correlationOf(machine);
    machine.finishRun(correlationId, "waiting", null);
    yield* writes.waitFor((_task, state) => state?.replica !== undefined);
    const replica = (yield* readState(running.taskId)).replica!;
    const away = yield* noticeMachineOutage(machine, writes);
    return { task: away, correlationId, replica };
  });

const moveTo = (
  task: ChannelTask,
  host: string,
  callerCeiling = task.requester.runtimeModeCeiling,
) =>
  Effect.gen(function* () {
    const workers = yield* ChannelRemoteWorkers;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    return yield* workers.move({
      taskId: task.taskId,
      host,
      actor: "user",
      owner: runtime.ownerToken,
      callerCeiling,
    });
  });

/** Dispatch without running the runtime's forward or fence passes. */
const dispatchMovedTask = (
  task: ChannelTask,
  destination: RemoteMachine,
  writes: ChannelWriteMilestones,
) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, runtime.ownerToken);
    const running = yield* writes.waitFor(
      (current) => current.status === "running" && current.generation === task.generation + 1,
    );
    yield* Deferred.await(destination.waitIdle);
    return running;
  });

describe("copies of remote work and host failover", () => {
  it.effect(
    "disabled host replication issues no capture commands while reports still settle",
    () => {
      const { machine, harness } = failoverHarness();
      return Effect.gen(function* () {
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          fleet: { hosts: { "mac-studio": { checkpointReplication: "off" } } },
        });
        const writes = yield* channelWriteMilestones;
        const task = yield* startFailoverTask(writes, machine);
        const correlationId = correlationOf(machine);
        machine.finishRun(correlationId, "completed", "Finished without copying.");
        yield* writes.waitFor((_task, state) => state?.settleRunId !== undefined);
        yield* TestClock.adjust(Duration.millis(REMOTE_SETTLE_WAIT_MS));
        yield* writes.waitFor((current) => current.status === "completed");
        assert.lengthOf(
          machine.scripts.filter((call) => call.kind === "capture"),
          0,
        );
        assert.isUndefined((yield* readState(task.taskId)).replica);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each([false, true])(
    "off wins staged channel payload publication (reenable=%s)",
    (reenable) => {
      const { machine, harness } = failoverHarness();
      return Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const fs = yield* FileSystem.FileSystem;
        const staged = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const rename = fs.rename;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            Object.defineProperty(fs, "rename", {
              value: (from: string, to: string) =>
                rename(from, to).pipe(
                  Effect.andThen(
                    to.includes("channel-replicas/")
                      ? Deferred.succeed(staged, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                        )
                      : Effect.void,
                  ),
                ),
            });
          }),
          () =>
            Effect.sync(() => {
              Object.defineProperty(fs, "rename", { value: rename });
            }),
        );
        const writes = yield* channelWriteMilestones;
        const task = yield* startFailoverTask(writes, machine);
        machine.finishRun(correlationOf(machine), "waiting", null);
        yield* Deferred.await(staged);
        yield* settings.updateSettings({ responseStreamingMode: "turn" });
        yield* settings.updateSettings({
          fleet: { hosts: { "mac-studio": { checkpointReplication: "off" } } },
        });
        if (reenable)
          yield* settings.updateSettings({
            fleet: { hosts: { "mac-studio": { checkpointReplication: "on" } } },
          });
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(machine.captureFibers, Fiber.await);
        assert.isUndefined((yield* readState(task.taskId)).replica);
        assert.deepStrictEqual(yield* replicaFiles, []);
        yield* settings.updateSettings({
          fleet: { hosts: { "mac-studio": { checkpointReplication: "on" } } },
        });
        machine.startRun(correlationOf(machine));
        machine.finishRun(correlationOf(machine), "waiting", null);
        yield* TestClock.adjust("2 seconds");
        yield* writes.waitFor((_task, state) => state?.replica !== undefined);
        assert.isDefined((yield* readState(task.taskId)).replica);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("cancelled channel publication removes staged bytes and releases admission", () => {
    const { machine, harness } = failoverHarness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const staged = yield* Deferred.make<void>();
      const rename = fs.rename;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Object.defineProperty(fs, "rename", {
            value: (from: string, to: string) =>
              rename(from, to).pipe(
                Effect.andThen(
                  to.includes("channel-replicas/")
                    ? Deferred.succeed(staged, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.void,
                ),
              ),
          });
        }),
        () =>
          Effect.sync(() => {
            Object.defineProperty(fs, "rename", { value: rename });
          }),
      );
      const writes = yield* channelWriteMilestones;
      const task = yield* startFailoverTask(writes, machine);
      machine.finishRun(correlationOf(machine), "waiting", null);
      yield* Deferred.await(staged);
      yield* Fiber.interrupt(machine.captureFibers[0]!);
      assert.isUndefined((yield* readState(task.taskId)).replica);
      assert.deepStrictEqual(yield* replicaFiles, []);
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        fleet: { hosts: { "mac-studio": { checkpointReplication: "off" } } },
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["completed", "waiting"] as const)(
    "saves the bundle after a %s turn and does not recapture that turn",
    (status) => {
      const { machine, harness } = failoverHarness();
      // Keep a completed run open so another observation can prove deduplication.
      machine.holds = { backgroundTasks: 1, continuationPending: false };
      return Effect.gen(function* () {
        const writes = yield* channelWriteMilestones;
        const task = yield* startFailoverTask(writes, machine);
        const correlationId = correlationOf(machine);
        const runId = machine.runs(correlationId).at(-1)!.runId;
        machine.finishRun(correlationId, status, "Turn ended.");
        yield* writes.waitFor((_task, state) => state?.replica?.key === runId + ":" + status);
        const replica = (yield* readState(task.taskId)).replica!;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = (yield* ServerConfig.ServerConfig).stateDir;
        assert.strictEqual(path.dirname(replica.file), path.join(stateDir, "channel-replicas"));
        assert.strictEqual(
          path.basename(replica.file),
          task.taskId.replace(/[^A-Za-z0-9_-]/gu, "_") +
            "-g1-" +
            REPLICA_COMMIT.slice(0, 16) +
            ".bundle",
        );
        assert.deepStrictEqual(yield* fs.readFile(replica.file), new Uint8Array(REPLICA_BYTES));
        assert.strictEqual(replica.bytes, REPLICA_BYTES.length);
        assert.strictEqual(replica.commitOid, REPLICA_COMMIT);
        assert.isFalse(Number.isNaN(Date.parse(replica.capturedAt)));
        machine.report(correlationId, "progress", "Observed the same turn again.");
        yield* writes.waitFor(
          (current) => current.resultSummary === "Observed the same turn again.",
        );
        assert.lengthOf(
          machine.scripts.filter((call) => call.kind === "capture"),
          1,
        );
        assert.deepStrictEqual((yield* readState(task.taskId)).replica, replica);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each([
    { output: "GOAT_REPLICA_TOO_LARGE 8388609\n", reason: "too_large" },
    { output: "GOAT_REPLICA_NO_WORKTREE\n", reason: "no_worktree" },
    { output: "truncated response", reason: "invalid" },
  ])("records $reason once without creating a bundle", ({ output, reason }) => {
    const { machine, harness } = failoverHarness();
    machine.captureOutput = output;
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const task = yield* startFailoverTask(writes, machine);
      const correlationId = correlationOf(machine);
      machine.finishRun(correlationId, "waiting", null);
      yield* writes.waitFor((_task, state) => state?.replicaSkipped?.reason === reason);
      const state = yield* readState(task.taskId);
      assert.isUndefined(state.replica);
      assert.strictEqual(
        state.replicaSkipped?.key,
        machine.runs(correlationId).at(-1)!.runId + ":waiting",
      );
      assert.deepStrictEqual(yield* replicaFiles, []);
      machine.report(correlationId, "progress", "Checked the skipped turn again.");
      yield* writes.waitFor(
        (current) => current.resultSummary === "Checked the skipped turn again.",
      );
      assert.lengthOf(machine.scripts, 1);
      assert.deepStrictEqual((yield* readState(task.taskId)).replicaSkipped, state.replicaSkipped);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves no record or bundle when the replica transport cannot connect", () => {
    const { machine, harness } = failoverHarness();
    machine.scriptDown = true;
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const task = yield* startFailoverTask(writes, machine);
      const correlationId = correlationOf(machine);
      machine.finishRun(correlationId, "waiting", null);
      yield* Deferred.await(machine.scriptCalled);
      yield* writes.waitFor((_task, state) => state?.knownRun?.status === "waiting");
      const failed = yield* readState(task.taskId);
      assert.isUndefined(failed.replica);
      assert.isUndefined(failed.replicaSkipped);
      assert.lengthOf(machine.scripts, 1);
      assert.deepStrictEqual(yield* replicaFiles, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    "no_replica",
    "host_reachable",
    "same_host",
    "unknown_host",
    "not_remote",
  ] as const)("refuses $reason without changing the task or remote state", (reason) => {
    const { machine, destination, harness } = failoverHarness();
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const task = yield* startFailoverTask(writes, machine, reason === "not_remote");
      if (reason === "no_replica") yield* noticeMachineOutage(machine, writes);
      const before = yield* onlyTask;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const stateBefore = yield* ledger.getRemoteWorker(task.taskId);
      const host =
        reason === "same_host"
          ? machine.host
          : reason === "unknown_host"
            ? "unknown-host"
            : destination.host;
      const result = yield* moveTo(before, host).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.strictEqual(result.failure._tag, "ChannelTaskMoveError");
      if (result.failure._tag !== "ChannelTaskMoveError") return;
      assert.strictEqual(result.failure.reason, reason);
      assert.deepStrictEqual(yield* onlyTask, before);
      assert.strictEqual(yield* ledger.getRemoteWorker(task.taskId), stateBefore);
      assert.lengthOf(destination.launches, 0);
      assert.lengthOf(destination.scripts, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["approval-required", "auto-accept-edits"] as const)(
    "refuses a mover with the lower %s ceiling without changing the task or state",
    (callerCeiling) => {
      const { machine, destination, harness } = failoverHarness();
      return Effect.gen(function* () {
        const writes = yield* channelWriteMilestones;
        const { task } = yield* prepareFailover(machine, writes);
        assert.strictEqual(task.requester.runtimeModeCeiling, "full-access");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const stateBefore = yield* ledger.getRemoteWorker(task.taskId);
        const result = yield* moveTo(task, destination.host, callerCeiling).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag !== "Failure" || result.failure._tag !== "ChannelTaskMoveError") {
          return yield* Effect.die("expected a move refusal");
        }
        assert.strictEqual(result.failure.reason, "not_allowed");
        assert.deepStrictEqual(yield* onlyTask, task);
        assert.strictEqual(yield* ledger.getRemoteWorker(task.taskId), stateBefore);
        assert.lengthOf(destination.scripts, 0);
        assert.lengthOf(destination.launches, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps the move's pinned snapshot when an in-flight turn captures a newer one", () => {
    const { machine, destination, harness } = failoverHarness();
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const task = yield* startFailoverTask(writes, machine);
      const correlationId = correlationOf(machine);
      machine.finishRun(correlationId, "waiting", null);
      yield* writes.waitFor((_task, state) => state?.replica !== undefined);
      const first = (yield* readState(task.taskId)).replica!;
      yield* Fiber.await(machine.captureFibers[0]!);
      const newerOid = "c".repeat(40);
      const newerBytes = Buffer.from("later changes that the move did not choose\n");
      machine.captureOutput = replicaOutput(newerOid, newerBytes);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      machine.captureGate = { entered, release };
      machine.startRun(correlationId);
      machine.finishRun(correlationId, "waiting", null);
      yield* Deferred.await(entered);
      // The capture started while reachable, but finishes only after move pins the old copy.
      const away = yield* noticeMachineOutage(machine, writes);
      yield* moveTo(away, destination.host);
      assert.strictEqual((yield* readState(task.taskId)).resumeFrom?.file, first.file);
      yield* Deferred.succeed(release, undefined);
      yield* writes.waitFor((_task, state) => state?.replica?.commitOid === newerOid);
      // Wait for pruning too, so the preserved-file assertions cannot race cleanup.
      yield* Fiber.await(machine.captureFibers[1]!);
      const state = yield* readState(task.taskId);
      const newer = state.replica!;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prefix = task.taskId.replace(/[^A-Za-z0-9_-]/gu, "_") + "-g1-";
      assert.strictEqual(
        path.basename(first.file),
        prefix + REPLICA_COMMIT.slice(0, 16) + ".bundle",
      );
      assert.strictEqual(path.basename(newer.file), prefix + newerOid.slice(0, 16) + ".bundle");
      assert.notStrictEqual(newer.file, first.file);
      assert.strictEqual(state.resumeFrom?.file, first.file);
      assert.strictEqual(state.resumeFrom?.commitOid, REPLICA_COMMIT);
      assert.deepStrictEqual(yield* fs.readFile(first.file), new Uint8Array(REPLICA_BYTES));
      assert.deepStrictEqual(yield* fs.readFile(newer.file), new Uint8Array(newerBytes));
      yield* dispatchMovedTask(task, destination, writes);
      const apply = destination.scripts.find((call) => call.kind === "apply")!;
      assert.include(apply.script, REPLICA_BYTES.toString("base64"));
      assert.notInclude(apply.script, newerBytes.toString("base64"));
      assert.strictEqual((yield* readState(task.taskId)).resumeFrom?.file, first.file);
      assert.deepStrictEqual(yield* fs.readFile(first.file), new Uint8Array(REPLICA_BYTES));
      assert.lengthOf(destination.launches, 1);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect(
    "retries a refused stale-worker probe before interrupting or marking it noticed",
    () => {
      const { machine, destination, harness } = failoverHarness();
      machine.refuseProbeWith = "orchestration_error";
      return Effect.gen(function* () {
        const writes = yield* channelWriteMilestones;
        const { task, correlationId } = yield* prepareFailover(machine, writes);
        yield* moveTo(task, destination.host);
        const running = yield* dispatchMovedTask(task, destination, writes);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const workers = yield* ChannelRemoteWorkers;
        machine.down = false;
        const firstProbe = machine.probeAttempted;
        const probesBefore = machine.probeCount;
        yield* workers.ensure(runtime.ownerToken);
        yield* Deferred.await(firstProbe);
        assert.strictEqual((yield* readState(task.taskId)).superseded?.[0]?.noticed, false);
        assert.lengthOf(machine.interrupts, 0);
        assert.deepStrictEqual(yield* onlyTask, running);
        const nextProbe = machine.probeAttempted;
        machine.refuseProbeWith = undefined;
        yield* TestClock.adjust(Duration.seconds(5));
        yield* Deferred.await(nextProbe);
        const noticed = yield* writes.waitFor(
          (_current, state) => state?.superseded?.[0]?.noticed === true,
        );
        assert.strictEqual(machine.probeCount - probesBefore, 2);
        assert.strictEqual(noticed.status, "running");
        assert.strictEqual(noticed.generation, running.generation);
        assert.strictEqual(noticed.resultSummary, REMOTE_COPY.staleMachineBack(machine.host));
        assert.lengthOf(machine.interrupts, 1);
        assert.strictEqual(machine.interrupts[0]?.threadId, machine.thread(correlationId));
        assert.lengthOf(destination.interrupts, 0);
        yield* runtime.drain;
        assert.strictEqual(yield* staleNotices(machine.host), 1);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect("settles a stale-worker probe reporting thread_not_found without an interrupt", () => {
    const { machine, destination, harness } = failoverHarness();
    machine.refuseProbeWith = "thread_not_found";
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const { task } = yield* prepareFailover(machine, writes);
      yield* moveTo(task, destination.host);
      const running = yield* dispatchMovedTask(task, destination, writes);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const workers = yield* ChannelRemoteWorkers;
      machine.down = false;
      const probesBefore = machine.probeCount;
      yield* workers.ensure(runtime.ownerToken);
      const noticed = yield* writes.waitFor(
        (_current, state) => state?.superseded?.[0]?.noticed === true,
      );
      assert.deepStrictEqual(noticed, running);
      assert.strictEqual(machine.probeCount - probesBefore, 1);
      assert.lengthOf(machine.interrupts, 0);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* workers.ensure(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual(machine.probeCount - probesBefore, 1);
      assert.lengthOf(machine.interrupts, 0);
      assert.strictEqual(yield* staleNotices(machine.host), 0);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("retries a refused interrupt without marking or narrating the stale worker yet", () => {
    const { machine, destination, harness } = failoverHarness();
    machine.refuseInterruptWith = "orchestration_error";
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const { task } = yield* prepareFailover(machine, writes);
      yield* moveTo(task, destination.host);
      yield* dispatchMovedTask(task, destination, writes);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const workers = yield* ChannelRemoteWorkers;
      machine.down = false;
      const firstAttempt = machine.interruptAttempted;
      yield* workers.ensure(runtime.ownerToken);
      yield* Deferred.await(firstAttempt);
      const secondAttempt = machine.interruptAttempted;
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Deferred.await(secondAttempt);
      assert.lengthOf(machine.interrupts, 2);
      assert.strictEqual((yield* readState(task.taskId)).superseded?.[0]?.noticed, false);
      yield* runtime.drain;
      assert.strictEqual(yield* staleNotices(machine.host), 0);
      machine.refuseInterruptWith = undefined;
      yield* TestClock.adjust(Duration.seconds(10));
      yield* writes.waitFor((_current, state) => state?.superseded?.[0]?.noticed === true);
      assert.lengthOf(machine.interrupts, 3);
      yield* runtime.drain;
      yield* TestClock.adjust(Duration.seconds(20));
      yield* workers.ensure(runtime.ownerToken);
      yield* runtime.drain;
      assert.lengthOf(machine.interrupts, 3);
      assert.strictEqual(yield* staleNotices(machine.host), 1);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("marks a stale worker whose interrupt reports thread_not_found as noticed", () => {
    const { machine, destination, harness } = failoverHarness();
    machine.refuseInterruptWith = "thread_not_found";
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const { task } = yield* prepareFailover(machine, writes);
      yield* moveTo(task, destination.host);
      yield* dispatchMovedTask(task, destination, writes);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const workers = yield* ChannelRemoteWorkers;
      machine.down = false;
      yield* workers.ensure(runtime.ownerToken);
      const noticed = yield* writes.waitFor(
        (_current, state) => state?.superseded?.[0]?.noticed === true,
      );
      assert.strictEqual(noticed.status, "running");
      assert.lengthOf(machine.interrupts, 1);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* workers.ensure(runtime.ownerToken);
      yield* runtime.drain;
      assert.lengthOf(machine.interrupts, 1);
      assert.strictEqual(yield* staleNotices(machine.host), 1);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect.each([0, 1])(
    "clears an answer recorded %i ms before the move without sending it to the new worker",
    (beforeMoveMs) => {
      const { machine, destination, harness } = failoverHarness();
      return Effect.gen(function* () {
        const writes = yield* channelWriteMilestones;
        const { task } = yield* prepareFailover(machine, writes);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const questionId = ChannelQuestionId.make("before-move-question");
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.opened",
            payload: {
              question: { questionId, text: "Which deploy target?", askedAt: task.updatedAt },
            },
          },
          { owner: runtime.ownerToken },
        );
        const answered = yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId, answer: "the old machine's staging target" },
          },
          {
            owner: runtime.ownerToken,
            forward: true,
            pendingAnswerMessageId: "answer-before-move",
          },
        );
        assert.isDefined(answered);
        const pending = (yield* ledger.listPendingForwards(50))[0]!;
        assert.strictEqual(pending.event.type, "task.question.answered");
        if (beforeMoveMs > 0) yield* TestClock.adjust(Duration.millis(beforeMoveMs));
        yield* moveTo(answered!, destination.host);
        const running = yield* dispatchMovedTask(task, destination, writes);
        assert.strictEqual(
          Date.parse(running.movedFrom!.at) - Date.parse(pending.event.occurredAt),
          beforeMoveMs,
        );
        // Keep the old forward until after the new worker is bound: the cutoff must discard it.
        assert.lengthOf(yield* ledger.listPendingForwards(50), 1);
        yield* (yield* ChannelRemoteWorkers).forward(pending, runtime.ownerToken);
        yield* writes.waitForForward(pending.sequence);
        assert.lengthOf(yield* ledger.listPendingForwards(50), 0);
        assert.lengthOf(destination.sends, 0);
        assert.lengthOf(machine.sends, 0);
        assert.isFalse(destination.calls.some((call) => call.tool === "goat_thread_send"));
        const state = yield* readState(task.taskId);
        assert.notInclude(state.forwarded, pending.event.eventId);
        assert.isUndefined(state.receipt);
        assert.strictEqual((yield* onlyTask).generation, running.generation);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "sweeps a finished moved task's unnoticed old worker on a fresh service's first ensure",
    () => {
      const { machine, destination, harness } = failoverHarness();
      return Effect.gen(function* () {
        const writes = yield* channelWriteMilestones;
        const { task } = yield* prepareFailover(machine, writes);
        yield* moveTo(task, destination.host);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.cancelled",
            payload: { reason: "Cancelled after moving." },
          },
          { owner: runtime.ownerToken },
        );
        // No runtime pass has started a fence for the moved task. Model a later process's scan.
        yield* TestClock.adjust(Duration.hours(1));
        machine.down = false;
        assert.strictEqual((yield* readState(task.taskId)).superseded?.[0]?.noticed, false);
        assert.lengthOf(machine.interrupts, 0);
        yield* Effect.gen(function* () {
          const fresh = yield* ChannelRemoteWorkers;
          yield* fresh.ensure(runtime.ownerToken);
          const noticed = yield* writes.waitFor(
            (_current, state) => state?.superseded?.[0]?.noticed === true,
          );
          assert.strictEqual(noticed.status, "cancelled");
          assert.strictEqual(noticed.generation, task.generation + 1);
          assert.lengthOf(machine.interrupts, 1);
          yield* TestClock.adjust(Duration.seconds(5));
          yield* fresh.ensure(runtime.ownerToken);
          assert.lengthOf(machine.interrupts, 1);
        }).pipe(Effect.provide(Layer.fresh(remoteWorkersLayer).pipe(Layer.provide(machine.layer))));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses a move when the recorded replica file has disappeared", () => {
    const { machine, destination, harness } = failoverHarness();
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const { task, replica } = yield* prepareFailover(machine, writes);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(replica.file);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const stateBefore = yield* ledger.getRemoteWorker(task.taskId);
      const result = yield* moveTo(task, destination.host).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure" && result.failure._tag === "ChannelTaskMoveError") {
        assert.strictEqual(result.failure.reason, "no_replica");
      } else assert.fail("expected no_replica");
      assert.deepStrictEqual(yield* onlyTask, task);
      assert.strictEqual(yield* ledger.getRemoteWorker(task.taskId), stateBefore);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("moves the next generation onto the copied work in the destination project", () => {
    const { machine, destination, harness } = failoverHarness();
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const { task, correlationId, replica } = yield* prepareFailover(machine, writes);
      const moved = yield* moveTo(task, destination.host);
      assert.deepStrictEqual(moved, {
        taskId: task.taskId,
        generation: task.generation + 1,
        host: destination.host,
        fromHost: machine.host,
        replicaCapturedAt: replica.capturedAt,
      });
      const event = yield* readTaskEvent(task, "task.moved");
      assert.strictEqual(event.type, "task.moved");
      assert.strictEqual(event.actor, "user");
      if (event.type !== "task.moved") return;
      assert.deepStrictEqual(event.payload, {
        generation: moved.generation,
        host: destination.host,
        fromHost: machine.host,
        replicaCapturedAt: replica.capturedAt,
      });
      const carried = yield* readState(task.taskId);
      assert.strictEqual(carried.resumeFrom?.generation, moved.generation);
      assert.strictEqual(carried.resumeFrom?.file, replica.file);
      assert.strictEqual(
        carried.resumeFrom?.ref,
        "refs/goat/replicas/" + task.taskId.replace(/[^A-Za-z0-9_-]/gu, "_") + "/1",
      );
      assert.strictEqual(carried.superseded?.[0]?.correlationId, correlationId);
      assert.strictEqual(carried.superseded?.[0]?.noticed, false);
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      const running = yield* writes.waitFor(
        (current) => current.status === "running" && current.generation === moved.generation,
      );
      assert.strictEqual(running.host, destination.host);
      assert.strictEqual(running.worker?.host, destination.host);
      assert.strictEqual(running.movedFrom?.host, machine.host);
      assert.lengthOf(destination.scripts, 1);
      assert.strictEqual(destination.scripts[0]?.kind, "apply");
      assert.strictEqual(destination.scripts[0]?.host, destination.host);
      assert.include(destination.scripts[0]!.script, REPLICA_BYTES.toString("base64"));
      assert.include(
        destination.scripts[0]!.script,
        "refs/heads/" + resumeBranchFor(task.taskId, moved.generation),
      );
      assert.lengthOf(destination.launches, 1);
      const launch = destination.launches[0]!;
      assert.strictEqual(launch.host, destination.host);
      assert.strictEqual(launch.cwd, "/srv/goat");
      assert.deepStrictEqual(launch.workspace, {
        type: "worktree",
        branch: remoteBranchFor(task.taskId, moved.generation),
        baseRef: "refs/heads/" + resumeBranchFor(task.taskId, moved.generation),
      });
      assert.strictEqual(
        launch.report?.correlationId,
        remoteCorrelationFor(task.taskId, moved.generation),
      );
      assert.notStrictEqual(launch.report?.correlationId, correlationId);
      assert.include(launch.message, "This continues work that started on mac-studio");
      assert.include(launch.message, replica.capturedAt);
      assert.include(launch.message, "Check git status and git log before you go on.");
      assert.lengthOf(machine.launches, 1);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("fences the returning host once and only accepts the new generation's outcome", () => {
    const { machine, destination, harness } = failoverHarness();
    return Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      const { task, correlationId } = yield* prepareFailover(machine, writes);
      const moved = yield* moveTo(task, destination.host);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      // A dispatcher pass may already start the fence; register before running that pass.
      const failed = machine.waitUnavailable;
      yield* runtime.drain;
      yield* writes.waitFor(
        (current) => current.status === "running" && current.generation === moved.generation,
      );
      yield* (yield* ChannelRemoteWorkers).ensure(runtime.ownerToken);
      yield* Deferred.await(failed);
      machine.finishRun(correlationId, "completed", "Old host claimed completion.");
      machine.report(correlationId, "completed", "Old host claimed completion.");
      machine.down = false;
      yield* TestClock.adjust(Duration.seconds(5));
      const fenced = yield* writes.waitFor(
        (_current, state) => state?.superseded?.[0]?.noticed === true,
      );
      assert.strictEqual(fenced.status, "running");
      assert.strictEqual(fenced.generation, moved.generation);
      assert.strictEqual(fenced.worker?.host, destination.host);
      assert.strictEqual(fenced.resultSummary, REMOTE_COPY.staleMachineBack(machine.host));
      assert.lengthOf(machine.interrupts, 1);
      assert.strictEqual(machine.interrupts[0]?.threadId, machine.thread(correlationId));
      assert.strictEqual(machine.interrupts[0]?.clientRequestId, "channel-fence:" + correlationId);
      assert.lengthOf(destination.interrupts, 0);
      const probe = machine.calls.find(
        (call) =>
          call.tool === "goat_origin_reports_wait" &&
          call.arguments.timeoutMs === 0 &&
          call.arguments.correlationId === correlationId,
      );
      assert.isDefined(probe);
      assert.strictEqual(probe?.host, machine.host);
      machine.finishRun(correlationId, "failed", "Old host then failed.");
      machine.report(correlationId, "failed", "Old host then failed.");
      // The old observer's outstanding outage backoff also expires; it must retire on g2.
      yield* TestClock.adjust(Duration.seconds(20));
      const currentCorrelation = correlationOf(destination);
      destination.report(currentCorrelation, "progress", "New worker is in charge.");
      yield* writes.waitFor((current) => current.resultSummary === "New worker is in charge.");
      yield* runtime.drain;
      yield* (yield* ChannelRemoteWorkers).ensure(runtime.ownerToken);
      yield* runtime.drain;
      assert.lengthOf(machine.interrupts, 1);
      assert.strictEqual(yield* staleNotices(machine.host), 1);
      const sql = yield* SqlClient.SqlClient;
      const premature =
        yield* sql`SELECT event_json FROM channel_task_events WHERE task_id = ${task.taskId} AND type IN ('task.completed', 'task.failed')`;
      assert.lengthOf(premature, 0);
      destination.finishRun(currentCorrelation, "completed", "Finished on the new host.");
      yield* writes.waitFor(
        (_current, state) =>
          state?.settleRunId === destination.runs(currentCorrelation).at(-1)!.runId,
      );
      yield* TestClock.adjust(Duration.millis(REMOTE_SETTLE_WAIT_MS));
      const done = yield* writes.waitFor((current) => current.status === "completed");
      assert.strictEqual(done.generation, moved.generation);
      assert.strictEqual(done.resultSummary, "Finished on the new host.");
      assert.strictEqual(done.worker?.host, destination.host);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect(
    "fails with resume_failed and tells the requester when the destination lacks base commits",
    () => {
      const { machine, destination, harness } = failoverHarness();
      destination.applyOutput = "GOAT_REPLICA_BASE_MISSING\n";
      return Effect.gen(function* () {
        const writes = yield* channelWriteMilestones;
        const { task } = yield* prepareFailover(machine, writes);
        const moved = yield* moveTo(task, destination.host);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* runtime.drain;
        const failed = yield* writes.waitFor((current) => current.status === "failed");
        const event = yield* readTaskEvent(failed, "task.failed");
        if (event.type !== "task.failed") return yield* Effect.die("expected task.failed");
        assert.strictEqual(event.payload.reason, "resume_failed");
        assert.strictEqual(event.payload.generation, moved.generation);
        assert.strictEqual(
          failed.resultSummary,
          REMOTE_COPY.resumeBaseMissing(destination.host, machine.host),
        );
        assert.lengthOf(destination.scripts, 1);
        assert.strictEqual(destination.scripts[0]?.kind, "apply");
        assert.lengthOf(destination.launches, 0);
        yield* runtime.drain;
        assert.strictEqual(
          (yield* latestCard)?.summary,
          REMOTE_COPY.resumeBaseMissing(destination.host, machine.host),
        );
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );
});

describe("memory grants on another machine", () => {
  it.effect.each([
    { scopes: [], ceiling: undefined },
    { scopes: ["memory:write"], ceiling: undefined },
    { scopes: ["memory:read"], ceiling: "read" },
    { scopes: ["memory:read", "memory:write"], ceiling: "read_write" },
  ] as const)(
    "forwards exactly the stored $ceiling ceiling from $scopes",
    ({ scopes, ceiling }) => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(goatInput("do@mac-studio: use memory", "remote-memory"), {
          ...rpcContext,
          grantedScopes: [...owner.grantedScopes, ...scopes],
        });
        const task = yield* until("running", (task) => task.status === "running");
        assert.strictEqual(task.status, "running");
        assert.strictEqual(task.target?.memoryGrantCeiling, ceiling);
        assert.lengthOf(machine.launches, 1);
        assert.strictEqual(
          machine.launches[0]!.memoryGrantCeiling,
          task.target?.memoryGrantCeiling,
        );
        if (ceiling === undefined) {
          assert.notProperty(task.target!, "memoryGrantCeiling");
          assert.notProperty(machine.launches[0]!, "memoryGrantCeiling");
        }
        assert.lengthOf(harness.world.launches, 0);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect("recovers a dispatching remote task with its stored ceiling", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const receipt = yield* gateway.ingest(
        goatInput("do@mac-studio: recover memory", "remote-memory-recovery"),
        { ...rpcContext, grantedScopes: [...owner.grantedScopes, "memory:read", "memory:write"] },
      );
      yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
        receipt.inputId,
        runtime.ownerToken,
      );
      const ledger = yield* ChannelLedger.ChannelLedger;
      const task = yield* onlyTask;
      assert.include(task.requester.grantedScopes, "memory:write");
      // Resume a conservative persisted claim without widening it to the requester's full grant.
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.dispatch.claimed",
          payload: {
            generation: task.generation,
            leaseExpiresAt: "2026-10-12T00:00:00.000Z",
            target: {
              environmentId: EnvironmentId.make(machine.environmentId),
              projectId: ProjectId.make(machine.projects[0]!.id),
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              memoryGrantCeiling: "read",
              remote: { host: machine.host, cwd: machine.projects[0]!.workspaceRoot },
            },
          },
        },
        { owner: runtime.ownerToken },
      );
      const recovered = yield* until("recovered", (task) => task.status === "running");
      assert.strictEqual(recovered.target?.memoryGrantCeiling, "read");
      assert.lengthOf(machine.launches, 1);
      assert.strictEqual(machine.launches[0]!.memoryGrantCeiling, "read");
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect(
    "fails an unsupported memory grant after the binding probe, without relaunching",
    () => {
      const { machine, harness } = remoteHarness();
      machine.refuseLaunchWith = "remote cannot honor memory; token=do-not-show";
      machine.refuseLaunchCode = SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED;
      return Effect.gen(function* () {
        yield* setupBot;
        yield* (yield* ChannelGateway.ChannelGateway).ingest(
          goatInput("do@mac-studio: memory required", "memory-refused"),
          { ...rpcContext, grantedScopes: [...owner.grantedScopes, "memory:read"] },
        );
        const task = yield* until("failed", (task) => task.status === "failed");
        const failure = yield* readTaskEvent(task, "task.failed");
        if (failure.type !== "task.failed") return yield* Effect.die("expected task.failed");
        assert.strictEqual(failure.payload.reason, "memory_unsupported");
        assert.strictEqual(failure.payload.summary, REMOTE_COPY.memoryUnsupported(machine.host));
        assert.strictEqual(task.status, "failed");
        assert.strictEqual(task.resultSummary, REMOTE_COPY.memoryUnsupported(machine.host));
        assert.strictEqual(task.target?.memoryGrantCeiling, "read");
        assert.strictEqual(machine.bindings.size, 0);
        assert.isTrue(machine.calls.some((call) => call.tool === "goat_origin_reports_wait"));
        // Even a later pass well beyond the launch grace must not retry without memory.
        yield* TestClock.adjust(Duration.minutes(6));
        yield* settle();
        assert.lengthOf(machine.launches, 1);
        assert.strictEqual(machine.launches[0]!.memoryGrantCeiling, "read");
        assert.lengthOf(harness.world.launches, 0);
        const records = yield* botMessages;
        assert.strictEqual(
          (yield* latestCard)?.summary,
          REMOTE_COPY.memoryUnsupported(machine.host),
        );
        assert.notInclude(JSON.stringify([task, records.messages]), "do-not-show");
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );
});

describe("reported outcomes from another machine", () => {
  it.effect.each([
    { outcome: "failed", reason: "reported_outcome" },
    { outcome: "cancelled", reason: "reported_cancelled" },
  ] as const)("fails a completed remote run reported as $outcome", ({ outcome, reason }) => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: deploy", "reported-failure"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      machine.finishRun(correlationOf(machine), "completed", "Claimed success.", {
        outcome,
        summary: "  Deployment failed.  ",
      });

      const task = yield* until("failed", (task) => task.status === "failed");
      const failure = yield* readTaskEvent(task, "task.failed");
      if (failure.type !== "task.failed") throw new Error("expected a failure");
      assert.strictEqual(failure.payload.reason, reason);
      assert.strictEqual(task.status, "failed");
      assert.strictEqual(task.resultSummary, "Deployment failed.");
      yield* settle();
      const records = yield* botMessages;
      assert.isFalse(
        records.turnItems.some(
          (item) => item.type === "notification" && item.ledgerTask?.status === "completed",
        ),
      );
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect.each(["failed", "cancelled"] as const)(
    "keeps remote run-level %s authoritative over a succeeded report",
    (status) => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(goatInput("do@mac-studio: deploy", "run-level-failure"), rpcContext);
        yield* until("running", (task) => task.status === "running");
        machine.finishRun(correlationOf(machine), status, "Assistant summary.", {
          outcome: "succeeded",
          summary: "Claimed success.",
        });

        const task = yield* until(status, (task) => task.status === status);
        const terminal = yield* readTaskEvent(
          task,
          status === "failed" ? "task.failed" : "task.cancelled",
        );
        assert.strictEqual((yield* onlyTask).status, status);
        if (status === "failed") {
          if (terminal.type !== "task.failed") throw new Error("expected failure");
          assert.strictEqual(terminal.payload.reason, "failed");
          assert.strictEqual(
            (yield* onlyTask).resultSummary,
            "The coding thread ended with failed.",
          );
        } else {
          assert.strictEqual(terminal.type, "task.cancelled");
          assert.strictEqual((yield* onlyTask).resultSummary, "The coding thread was stopped.");
        }
        assert.isUndefined((yield* onlyTask).completionReport);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect.each([
    { disposition: "failed-check", automatic: false },
    { disposition: "not-run", automatic: false },
    { disposition: "failed-check", automatic: true },
    { disposition: "not-run", automatic: true },
  ] as const)(
    "keeps late remote $disposition beside reported success (automatic: $automatic)",
    ({ disposition, automatic }) => {
      const { machine, harness } = automatic ? autoPlacementHarness() : remoteHarness();
      return Effect.gen(function* () {
        const writes = yield* channelWriteMilestones;
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        yield* gateway.ingest(
          goatInput(
            automatic ? "do: verify the check" : "do@mac-studio: verify the check",
            "late-check",
          ),
          rpcContext,
        );
        yield* runtime.drain;
        const running = yield* writes.waitFor((task) => task.status === "running");
        const correlation = correlationOf(machine);
        const runId = RunId.make(running.worker!.runId!);
        const tests = { ok: true, command: "vp test run", passed: 12, failed: 0 };
        const settling = yield* Deferred.make<void>();
        machine.onWait = (input) =>
          input.timeoutMs === REMOTE_SETTLE_WAIT_MS
            ? Deferred.succeed(settling, undefined).pipe(Effect.asVoid)
            : Effect.void;
        machine.observeRun(correlation, {
          pullRequests: [],
          needsYou: [],
          result: { runId, tests, observedCheckPending: true },
        });
        machine.finishRun(correlation, "completed", "Done.", {
          outcome: "succeeded",
          summary: "Done and verified.",
        });
        yield* Deferred.await(settling);
        yield* TestClock.adjust(REMOTE_SETTLE_WAIT_MS);
        const completed = yield* writes.waitFor((task) => task.status === "completed");
        assert.isUndefined(completed.observed?.result?.observedCheck);
        const check = {
          status: "running" as const,
          command: "vp test run",
          exitCode: null,
          durationMs: null,
          at: "2026-10-12T00:00:00.000Z",
        };
        machine.observeRun(correlation, {
          pullRequests: [],
          needsYou: [],
          result: { runId, tests, observedCheck: check, observedCheckPending: true },
        });
        yield* Effect.raceFirst(
          writes.waitFor((task) => task.observed?.result?.observedCheck?.status === "running"),
          Deferred.await(machine.authorizationDenied).pipe(
            Effect.andThen(
              Effect.die(new Error("pending terminal evidence authorization was rejected")),
            ),
          ),
        );
        // A terminal task ignores late agent claims, including requests to reopen it.
        machine.report(correlation, "needs_input", "Run it again?");
        const finalCheck = {
          ...check,
          status: "completed" as const,
          exitCode: 3,
          durationMs: 1250,
          outputTail: "one test failed",
        };
        machine.observeRun(correlation, {
          pullRequests: [],
          needsYou: [],
          result: {
            runId,
            tests,
            ...(disposition === "failed-check" ? { observedCheck: finalCheck } : {}),
            observedCheckPending: false,
          },
        });
        const final = yield* writes.waitFor(
          (task) => task.observed?.result?.observedCheckPending === false,
        );
        assert.strictEqual(final.status, "completed");
        assert.strictEqual(final.completedAt, completed.completedAt);
        assert.strictEqual(final.resultSummary, completed.resultSummary);
        assert.strictEqual(final.completionReport, "present");
        assert.deepStrictEqual(final.openQuestions, []);
        assert.deepStrictEqual(final.observed?.result, {
          runId,
          tests,
          ...(disposition === "failed-check" ? { observedCheck: finalCheck } : {}),
          observedCheckPending: false,
        });
        yield* runtime.drain;
        machine.timeoutWait();
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).version, final.version);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM channel_task_events WHERE type = 'task.completed'`;
        assert.strictEqual(rows[0]?.count, 1);
        assert.isTrue(
          machine.calls.some(
            (call) =>
              call.tool === "goat_origin_reports_wait" && call.arguments.watchRunId === runId,
          ),
        );
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect.each(["present", "missing"] as const)(
    "completes a remote worker with report %s",
    (report) => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(goatInput("do@mac-studio: deploy", "reported-success"), rpcContext);
        yield* until("running", (task) => task.status === "running");
        machine.finishRun(
          correlationOf(machine),
          "completed",
          "Assistant summary.",
          report === "present"
            ? { outcome: "succeeded", summary: "  Verified deployment.  " }
            : undefined,
        );

        const task = yield* until("completed", (task) => task.status === "completed", 400);
        const completion = yield* readTaskEvent(task, "task.completed");
        if (completion.type !== "task.completed") throw new Error("expected completion");
        const summary = report === "present" ? "Verified deployment." : "Assistant summary.";
        assert.strictEqual(completion.payload.report, report);
        assert.strictEqual(completion.payload.summary, summary);
        assert.strictEqual(task.status, "completed");
        assert.strictEqual(task.resultSummary, summary);
        assert.strictEqual(task.completionReport, report);
        yield* settle();
        const records = yield* botMessages;
        const chips = records.turnItems.flatMap((item) =>
          item.type === "notification" && item.ledgerTask !== undefined ? [item.ledgerTask] : [],
        );
        assert.strictEqual(chips.at(-1)?.completionReport, report);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect.each([
    { summary: "  Which target?  ", question: "Which target?" },
    {
      summary: undefined,
      question:
        "The worker reported that it is blocked without giving a reason. How should it continue?",
    },
  ])(
    "asks about a blocked remote run and resumes the same task ($summary)",
    ({ summary, question }) => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(goatInput("do@mac-studio: deploy", "reported-blocked"), rpcContext);
        yield* until("running", (task) => task.status === "running");
        const original = yield* onlyTask;
        const correlationId = correlationOf(machine);
        machine.finishRun(correlationId, "completed", "Done.", {
          outcome: "blocked",
          ...(summary === undefined ? {} : { summary }),
        });

        const waiting = yield* until("blocked", (task) => task.status === "waiting_input", 400);
        assert.strictEqual(waiting.status, "waiting_input");
        assert.strictEqual(waiting.openQuestions.length, 1);
        assert.strictEqual(waiting.openQuestions[0]?.text, question);
        yield* gateway.ingest(goatInput("answer: staging", "reported-blocked-answer"), rpcContext);
        const resumed = yield* until(
          "resumed with a new run",
          (task) => task.status === "running" && task.worker?.runId !== original.worker?.runId,
        );
        assert.strictEqual(resumed.taskId, original.taskId);
        assert.strictEqual(resumed.generation, original.generation);
        assert.strictEqual(resumed.status, "running");
        assert.deepStrictEqual(resumed.openQuestions, []);
        assert.strictEqual(resumed.worker?.threadId, original.worker?.threadId);
        assert.strictEqual(machine.runs(correlationId).length, 2);
        assert.strictEqual(machine.launches.length, 1);
        assert.strictEqual(machine.sends.length, 1);
        machine.finishRun(correlationId, "completed", "Deployed to staging.");

        yield* until("completed", (task) => task.status === "completed", 400);
        assert.strictEqual((yield* onlyTask).resultSummary, "Deployed to staging.");
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );
});

describe("remote worker observations", () => {
  const startObserved = (machine: RemoteMachine) =>
    Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: observe the worker", "observed"), rpcContext);
      const running = yield* until("running", (task) => task.status === "running");
      const waits: Array<Readonly<Record<string, unknown>>> = [];
      machine.onWait = (request) => Effect.sync(() => void waits.push(request));
      return { taskId: running.taskId, correlationId: correlationOf(machine), waits };
    });

  it.effect(
    "persists native questions and PRs, commits their observation, and echoes them on the next wait",
    () => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        const { taskId, correlationId, waits } = yield* startObserved(machine);
        const pendingRequestIds = [RuntimeRequestId.make("native-question")];
        const observation: ChannelWorkerObservation = {
          pullRequests: [
            {
              repository: "goat-si/goat",
              number: 42,
              url: "https://github.com/goat-si/goat/pull/42",
              watching: true,
            },
          ],
          needsYou: [{ kind: "question", since: "2026-10-12T00:00:00.000Z" }],
        };
        machine.observeRun(correlationId, observation, pendingRequestIds);
        const observed = yield* until("observed", (task) => task.observed?.needsYou.length === 1);
        assert.strictEqual(observed.status, "running");
        assert.deepStrictEqual(observed.observed, observation);
        const event = yield* readTaskEvent(observed, "task.worker.observed");
        if (event.type !== "task.worker.observed") throw new Error("expected an observation");
        assert.deepStrictEqual(event.payload.observed, observation);

        yield* settle();
        const state = yield* readState(taskId);
        assert.deepStrictEqual(state.knownRun, {
          runId: observed.worker!.runId!,
          status: "running",
          pendingRequestIds,
          observation,
        });
        // The next long poll sends what this machine last saw, so the remote waits on real change.
        assert.isTrue(
          waits.some(
            (request) => JSON.stringify(request.knownRun) === JSON.stringify(state.knownRun),
          ),
        );

        machine.observeRun(correlationId, { pullRequests: [], needsYou: [] });
        const cleared = yield* until(
          "cleared",
          (task) =>
            task.observed !== undefined &&
            task.observed.needsYou.length === 0 &&
            task.observed.pullRequests.length === 0,
        );
        assert.strictEqual(cleared.status, "running");
        yield* settle();
        assert.deepStrictEqual((yield* readState(taskId)).knownRun?.pendingRequestIds, []);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect.each(["needs a person", "waits for reset"] as const)(
    "keeps a failed usage-limited worker running when it %s and follows its continuation",
    (choice) => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        const { correlationId } = yield* startObserved(machine);
        const observation: ChannelWorkerObservation =
          choice === "needs a person"
            ? {
                pullRequests: [],
                needsYou: [{ kind: "usage_limit", since: "2026-10-12T00:00:00.000Z" }],
              }
            : { pullRequests: [], needsYou: [], usageLimitResetAt: "2099-01-01T00:00:00.000Z" };
        machine.observeRun(correlationId, observation);
        machine.finishRun(correlationId, "failed", "Provider usage limit.");
        yield* until("observed", (task) => task.observed !== undefined);
        // Well past the settle look an ordinary failed run gets, the task is still open.
        yield* settle(3 * (REMOTE_SETTLE_WAIT_MS / 100));
        const paused = yield* onlyTask;
        assert.strictEqual(paused.status, "running");
        assert.deepStrictEqual(paused.observed, observation);

        const continuation = machine.startRun(correlationId);
        machine.observeRun(correlationId, { pullRequests: [], needsYou: [] });
        const resumed = yield* until("rebound", (task) => task.worker?.runId === continuation);
        assert.strictEqual(resumed.status, "running");
        const settled = yield* until(
          "observation cleared",
          (task) =>
            task.observed?.usageLimitResetAt === undefined && task.observed?.needsYou.length === 0,
        );
        assert.deepStrictEqual(settled.observed, { pullRequests: [], needsYou: [] });
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect("still fails an ordinary failed run that reports an observation", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      const { correlationId } = yield* startObserved(machine);
      machine.observeRun(correlationId, { pullRequests: [], needsYou: [] });
      machine.finishRun(correlationId, "failed", "Compiler error.");
      const failed = yield* until("failed", (task) => task.status === "failed");
      const event = yield* readTaskEvent(failed, "task.failed");
      assert.strictEqual(event.type, "task.failed");
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });
});

describe("tasks on another machine", () => {
  it.effect(
    "launch there under the requester's ceiling, import reports, and send the result back to Slack",
    () => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(slackInput("do@mac-studio: build the thing", "m1"), slackContext);
        const running = yield* until("running", (task) => task.status === "running");

        // Launched once, over SSH, in the existing remote project, with a report binding.
        assert.strictEqual(machine.launches.length, 1);
        const launch = machine.launches[0]!;
        assert.strictEqual(launch.cwd, "/Users/jun/developer/goat-si/goat");
        assert.strictEqual(launch.workspace.type, "worktree");
        // The Slack link's ceiling bounds the remote session and the thread.
        assert.strictEqual(launch.callerRuntimeMode, "auto-accept-edits");
        assert.strictEqual(launch.runtimeMode, "auto-accept-edits");
        assert.isTrue(machine.calls.every((call) => call.ceiling === "auto-accept-edits"));
        const state = yield* readState(running.taskId);
        assert.strictEqual(launch.report?.readKeyHash, sha256(state.readKey));
        assert.include(launch.message ?? "", "needs_input");
        assert.deepStrictEqual(
          { host: running.worker?.host, environmentId: running.worker?.environmentId },
          { host: "mac-studio", environmentId: machine.environmentId },
        );

        const correlationId = correlationOf(machine);
        machine.report(correlationId, "progress", "Halfway there.");
        yield* until("progress", (task) => task.resultSummary === "Halfway there.");
        machine.report(correlationId, "completed", "Built it (claimed).");
        machine.finishRun(correlationId, "completed", "Built it.");
        const done = yield* until("completed", (task) => task.status === "completed", 400);
        assert.strictEqual(done.resultSummary, "Built it.");
        yield* settle();

        const results = resultsTo(harness.slackSent, "result");
        assert.strictEqual(results.length, 1);
        // The bot chip links to the worker on the other machine.
        const records = yield* botMessages;
        const chip = records.turnItems
          .flatMap((item) => (item.type === "notification" ? [item] : []))
          .flatMap((item) => (item.ledgerTask === undefined ? [] : [item.ledgerTask]))
          .at(-1);
        assert.strictEqual(chip?.worker?.host, "mac-studio");
        // The read key never leaves this machine's state row.
        const ledger = yield* ChannelLedger.ChannelLedger;
        const events = yield* ledger.listTasks({ ownerId: running.requester.ownerId, limit: 5 });
        const visible = JSON.stringify([harness.slackSent, records.messages, events]);
        assert.notInclude(visible, state.readKey);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("asks the requester, forwards the answer there, and follows the answer's run", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: pick a branch", "g1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const correlationId = correlationOf(machine);
      machine.report(correlationId, "needs_input", "Which branch?");
      machine.finishRun(correlationId, "completed", "Waiting for an answer.");
      const asked = yield* until("question", (task) => task.status === "waiting_input");
      assert.strictEqual(asked.openQuestions[0]?.text, "Which branch?");
      // A finished run with an open question is not a finished task.
      yield* TestClock.adjust(Duration.millis(REMOTE_SETTLE_WAIT_MS * 2));
      yield* settle();
      assert.strictEqual((yield* onlyTask).status, "waiting_input");

      yield* gateway.ingest(goatInput("answer: use main", "g2"), rpcContext);
      yield* until("answer sent", () => machine.sends.length === 1);
      assert.include(machine.sends[0]?.message as string, "use main");
      assert.isTrue(
        machine.calls
          .filter((call) => call.tool === "goat_thread_send")
          .every((call) => call.ceiling === "full-access"),
      );
      const followed = yield* until(
        "rebound",
        (task) =>
          task.status === "running" && task.worker?.runId === machine.runs(correlationId)[1]?.runId,
      );
      assert.strictEqual(followed.openQuestions.length, 0);
      machine.finishRun(correlationId, "completed", "Used main.");
      const done = yield* until("completed", (task) => task.status === "completed", 400);
      assert.strictEqual(done.resultSummary, "Used main.");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("finds the thread an unanswered launch started instead of starting another", () => {
    const { machine, harness } = remoteHarness();
    machine.loseNextLaunchAnswer = true;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: once only", "l1"), rpcContext);
      const running = yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches.length, 1);
      assert.strictEqual(machine.threads.size, 1);
      assert.strictEqual(running.worker?.threadId, machine.thread(correlationOf(machine)));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "tells the requester once when the machine is unreachable and again on reconnect",
    () => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(goatInput("do@mac-studio: long job", "o1"), rpcContext);
        yield* until("running", (task) => task.status === "running");
        const correlationId = correlationOf(machine);
        machine.down = true;
        for (let step = 0; step < 30; step += 1) {
          yield* TestClock.adjust(Duration.seconds(30));
          yield* settle(2);
        }
        const away = yield* onlyTask;
        assert.strictEqual(away.status, "running");
        assert.strictEqual(away.resultSummary, REMOTE_COPY.outage(machine.host));
        // Filed while this machine could not look; it arrives after the reconnect notice.
        machine.report(correlationId, "progress", "unseen while down");
        machine.down = false;
        yield* TestClock.adjust(Duration.minutes(6));
        const back = yield* until(
          "reconnected",
          (task) => task.resultSummary === "unseen while down",
          400,
        );
        assert.strictEqual(back.status, "running");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const state = JSON.parse((yield* ledger.getRemoteWorker(back.taskId)) ?? "{}");
        assert.strictEqual(state.outageNoticed, false);
        machine.finishRun(correlationId, "completed", "Done after the outage.");
        const done = yield* until("completed", (task) => task.status === "completed", 400);
        assert.strictEqual(done.resultSummary, "Done after the outage.");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("ignores the previous generation's reports after a retry", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: flaky", "r1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const first = correlationOf(machine);
      machine.report(first, "failed", "It broke.");
      const failed = yield* until("failed", (task) => task.status === "failed");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const stored = (yield* ledger.getTask(failed.taskId))!;
      yield* commitTransition(ledger, stored, {
        type: "task.retry.requested",
        payload: { generation: 2 },
      });
      const again = yield* until(
        "second generation running",
        (task) => task.status === "running" && task.generation === 2,
      );
      const second = correlationOf(machine);
      assert.notStrictEqual(second, first);
      assert.strictEqual(machine.launches.length, 2);
      // The first generation's worker keeps talking; none of it reaches the task.
      machine.report(first, "completed", "Stale success.");
      machine.report(first, "needs_input", "Stale question?");
      yield* settle(80);
      const after = yield* onlyTask;
      assert.strictEqual(after.status, "running");
      assert.strictEqual(after.worker?.threadId, again.worker?.threadId);
      assert.deepStrictEqual(after.openQuestions, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("runs the work here when the requester answers this machine", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@unknown-box: anywhere", "s1"), rpcContext);
      yield* until("asked", (task) => task.status === "waiting_input");
      yield* gateway.ingest(goatInput("answer: this machine", "s2"), rpcContext);
      const local = yield* until("running here", (task) => task.status === "running");
      assert.isUndefined(local.host);
      assert.isUndefined(local.worker?.host);
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks which machine when the requested one is not known here", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@unknown-box: somewhere", "u1"), rpcContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.unknownHost("unknown-box", [machine.host]),
      );
      yield* gateway.ingest(goatInput("answer: use mac-studio", "u2"), rpcContext);
      const there = yield* until("running there", (task) => task.status === "running");
      assert.strictEqual(there.worker?.host, machine.host);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("neither offers nor accepts a machine seen only in known_hosts", () => {
    const { machine, harness } = remoteHarness();
    machine.knownHostsOnly = ["visited-box"];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@visited-box: somewhere", "k1"), rpcContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.unknownHost("visited-box", [machine.host]),
      );
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops a late question from the run before the answer", () => {
    const { machine, harness } = remoteHarness();
    machine.staleQuestionOnSend = true;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: needs a choice", "q1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const correlationId = correlationOf(machine);
      machine.report(correlationId, "needs_input", "Which one?");
      machine.finishRun(correlationId, "completed", "Asked.");
      yield* until("question", (task) => task.status === "waiting_input");
      yield* gateway.ingest(goatInput("answer: the second", "q2"), rpcContext);
      const answerRun = () => machine.runs(correlationId)[1]?.runId;
      const followed = yield* until(
        "answer run",
        (task) => task.status === "running" && task.worker?.runId === answerRun(),
      );
      yield* settle(40);
      const after = yield* onlyTask;
      assert.strictEqual(after.status, "running");
      assert.deepStrictEqual(after.openQuestions, []);
      assert.strictEqual(after.worker?.runId, followed.worker?.runId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("imports a report once even when the other machine sends it again", () => {
    const { machine, harness } = remoteHarness();
    machine.replayReports = true;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: chatty", "p1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const correlationId = correlationOf(machine);
      machine.report(correlationId, "progress", "Step one.");
      const first = yield* until("progress", (task) => task.resultSummary === "Step one.");
      machine.report(correlationId, "needs_input", "Keep going?");
      const asked = yield* until("question", (task) => task.status === "waiting_input");
      yield* settle(60);
      const after = yield* onlyTask;
      assert.strictEqual(after.version, asked.version);
      assert.strictEqual(after.openQuestions.length, 1);
      assert.isAbove(asked.version, first.version);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("launches and observers on another machine", () => {
  it.effect("waits for a thread the remote is still creating, then binds it", () => {
    const { machine, harness } = remoteHarness();
    machine.slowThreadCreation = true;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: slow start", "w1"), rpcContext);
      yield* settle(60);
      assert.strictEqual((yield* onlyTask).status, "dispatching");
      machine.revealThread(correlationOf(machine));
      const running = yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches.length, 1);
      assert.strictEqual(running.worker?.threadId, machine.thread(correlationOf(machine)));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("gives up after three launch attempts that never reached the remote", () => {
    const { machine, harness } = remoteHarness();
    machine.failBeforeBinding = 10;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: unlucky", "x1"), rpcContext);
      const failed = yield* until("failed", (task) => task.status === "failed", 400);
      assert.strictEqual(failed.resultSummary, REMOTE_COPY.launchUncertain(machine.host));
      assert.strictEqual(machine.launches.length, 3);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a refused launch in fixed words, never the remote's text", () => {
    const { machine, harness } = remoteHarness();
    machine.refuseLaunchWith = "refused: token=sentinel-secret-do-not-leak";
    const logs: Array<string> = [];
    const logger = Logger.make(({ message }) => {
      logs.push(JSON.stringify(message));
    });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: refused", "z1"), slackContext);
      const failed = yield* until("failed", (task) => task.status === "failed");
      assert.strictEqual(failed.resultSummary, REMOTE_COPY.launchRefused(machine.host));
      yield* settle();
      const records = yield* botMessages;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const state = (yield* ledger.getRemoteWorker(failed.taskId)) ?? "";
      const visible = JSON.stringify([harness.slackSent, records.messages, failed]);
      assert.notInclude(visible, "sentinel-secret-do-not-leak");
      assert.notInclude(visible, JSON.parse(state).readKey);
      // The logs say what failed without quoting the remote or the read key.
      const logged = logs.join("\n");
      assert.include(logged, "channel remote launch failed");
      assert.notInclude(logged, "sentinel-secret-do-not-leak");
      assert.notInclude(logged, JSON.parse(state).readKey);
    }).pipe(
      Effect.provide(
        Layer.merge(harness.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("drops an old generation's late answer instead of failing the new one", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: retried", "h1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const first = correlationOf(machine);
      // The first generation's observer is stuck in a wait while the task is retried.
      machine.holdWaitsFor = first;
      machine.report(first, "progress", "held");
      yield* settle(10);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const running = (yield* ledger.getTask((yield* onlyTask).taskId))!;
      const cancelled = yield* commitTransition(ledger, running, {
        type: "task.cancelled",
        payload: { reason: "Retrying." },
      });
      const stored = (yield* ledger.getTask(cancelled!.taskId))!;
      yield* commitTransition(ledger, stored, {
        type: "task.retry.requested",
        payload: { generation: 2 },
      });
      const second = yield* until(
        "second generation running",
        (task) => task.status === "running" && task.generation === 2,
      );
      // The old wait now answers with the old thread; nothing about generation 2 changes.
      yield* Deferred.succeed(machine.release, undefined);
      yield* settle(40);
      const after = yield* onlyTask;
      assert.strictEqual(after.status, "running");
      assert.strictEqual(after.generation, 2);
      assert.strictEqual(after.worker?.threadId, second.worker?.threadId);
      assert.notStrictEqual(after.resultSummary, "held");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("tells the requester about an outage exactly once", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: patient", "n1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      machine.down = true;
      for (let step = 0; step < 40; step += 1) {
        yield* TestClock.adjust(Duration.seconds(30));
        yield* settle(2);
      }
      const noticed = yield* onlyTask;
      assert.strictEqual(noticed.resultSummary, REMOTE_COPY.outage(machine.host));
      // Much longer down: retries continue, the task does not change again.
      for (let step = 0; step < 40; step += 1) {
        yield* TestClock.adjust(Duration.minutes(5));
        yield* settle(2);
      }
      const later = yield* onlyTask;
      assert.strictEqual(later.version, noticed.version);
      assert.strictEqual(later.status, "running");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ends a task whose worker asked and then failed", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: asks then dies", "f1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const correlationId = correlationOf(machine);
      machine.report(correlationId, "needs_input", "Which way?");
      yield* until("question", (task) => task.status === "waiting_input");
      machine.finishRun(correlationId, "interrupted", null);
      const ended = yield* until("failed", (task) => task.status === "failed");
      assert.strictEqual(ended.resultSummary, "The coding thread ended with interrupted.");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("answers and settlement on another machine", () => {
  const askAndAnswer = (machine: RemoteMachine, key: string) =>
    Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: ask me", key + "-1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const correlationId = correlationOf(machine);
      machine.report(correlationId, "needs_input", "Which one?");
      machine.finishRun(correlationId, "completed", "Asked.");
      yield* until("question", (task) => task.status === "waiting_input");
      yield* gateway.ingest(goatInput("answer: the first", key + "-2"), rpcContext);
      return correlationId;
    });

  it.effect("asks again when the remote refuses the answer for the thread's modes", () => {
    const { machine, harness } = remoteHarness();
    machine.refuseSendWith = "runtime_mode_escalation_denied";
    return Effect.gen(function* () {
      yield* askAndAnswer(machine, "m");
      const asked = yield* until(
        "asked again",
        (task) =>
          task.status === "waiting_input" &&
          task.openQuestions.length === 1 &&
          machine.sends.length > 0,
      );
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.answerRefused(machine.host, "the first"),
      );
      yield* settle(40);
      assert.strictEqual(machine.sends.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("follows a newer run than the answer's and takes its question", () => {
    const { machine, harness } = remoteHarness();
    machine.questionInRunAfterAnswer = "And the colour?";
    return Effect.gen(function* () {
      const correlationId = yield* askAndAnswer(machine, "c");
      const asked = yield* until(
        "second question",
        (task) =>
          task.status === "waiting_input" && task.openQuestions[0]?.text === "And the colour?",
      );
      assert.strictEqual(asked.worker?.runId, machine.runs(correlationId)[2]?.runId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("follows the newest run when the answer's run never shows up", () => {
    const { machine, harness } = remoteHarness();
    machine.sendNamesMissingRun = true;
    return Effect.gen(function* () {
      const correlationId = yield* askAndAnswer(machine, "r");
      const followed = yield* until(
        "newest run",
        (task) =>
          task.status === "running" && task.worker?.runId === machine.runs(correlationId)[1]?.runId,
      );
      machine.finishRun(correlationId, "completed", "Done anyway.");
      const done = yield* until("completed", (task) => task.status === "completed", 400);
      assert.strictEqual(done.worker?.runId, followed.worker?.runId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["background", "continuation"] as const)(
    "keeps a finished run open while the remote reports %s work still to come",
    (hold) => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(
          goatInput("do@mac-studio: build in the background", "h1"),
          rpcContext,
        );
        yield* until("running", (task) => task.status === "running");
        const correlationId = correlationOf(machine);
        machine.holds = {
          backgroundTasks: hold === "background" ? 1 : 0,
          continuationPending: hold === "continuation",
        };
        machine.finishRun(correlationId, "completed", "Started the build.");
        // Well past the second look that settles a finished run with nothing holding it.
        yield* settle(300);
        assert.strictEqual((yield* onlyTask).status, "running");
        machine.setHolds({ backgroundTasks: 0, continuationPending: false });
        const done = yield* until("completed", (task) => task.status === "completed", 400);
        assert.strictEqual(done.resultSummary, "Started the build.");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "does not settle a finished run when a continuation starts during the second look",
    () => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(goatInput("do@mac-studio: continues", "k1"), rpcContext);
        yield* until("running", (task) => task.status === "running");
        const correlationId = correlationOf(machine);
        machine.finishRun(correlationId, "completed", "First part.");
        // The first look at the finished run; the second look is ten seconds away.
        yield* settle(5, 10);
        machine.startRun(correlationId);
        const moved = yield* until(
          "continuation",
          (task) => task.worker?.runId === machine.runs(correlationId)[1]?.runId,
        );
        assert.strictEqual(moved.status, "running");
        machine.finishRun(correlationId, "completed", "Second part.");
        const done = yield* until("completed", (task) => task.status === "completed", 400);
        assert.strictEqual(done.resultSummary, "Second part.");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("fails as uncertain when a thread the remote was creating never shows up", () => {
    const { machine, harness } = remoteHarness();
    machine.slowThreadCreation = true;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: never", "v1"), rpcContext);
      yield* settle(20);
      yield* TestClock.adjust(Duration.minutes(6));
      const failed = yield* until("failed", (task) => task.status === "failed");
      assert.strictEqual(failed.resultSummary, REMOTE_COPY.launchUncertain(machine.host));
      assert.strictEqual(machine.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never starts here what may already run on the other machine", () => {
    const { machine, harness } = remoteHarness();
    machine.failBeforeBinding = 1;
    machine.dropProjectsOnFailedLaunch = true;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: moved", "y1"), rpcContext);
      // The attempt fails and the project disappears there, so the dispatcher asks; the
      // requester then picks this machine.
      yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(machine.launches.length, 1);
      yield* gateway.ingest(goatInput("answer: this machine", "y2"), rpcContext);
      const failed = yield* until("failed", (task) => task.status === "failed");
      assert.strictEqual(failed.resultSummary, REMOTE_COPY.launchUncertain(machine.host));
      assert.strictEqual(harness.world.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("Slack defaults for work on another machine", () => {
  const slackModel = { instanceId: ProviderInstanceId.make("codex"), model: "slack-default" };
  const remoteModel = { instanceId: ProviderInstanceId.make("codex"), model: "remote-default" };

  /** A machine whose project has its own default model, and a Slack connection's defaults. */
  const defaultsHarness = (defaultTarget: {
    readonly projectId?: ProjectId;
    readonly modelSelection?: typeof slackModel;
  }) => {
    const machine = new RemoteMachine();
    machine.projects = machine.projects.map((project) => ({
      ...project,
      defaultModelSelection: remoteModel as never,
    }));
    const settings = Layer.effect(
      SlackChannelSettings.SlackChannelSettings,
      Effect.gen(function* () {
        const unavailable = yield* SlackChannelSettings.SlackChannelSettings;
        return SlackChannelSettings.SlackChannelSettings.of({
          ...unavailable,
          defaultTarget: () => Effect.succeed(Option.some(defaultTarget)),
        });
      }),
    ).pipe(Layer.provide(SlackChannelSettings.layerUnavailable));
    const harness = makeHarness({
      sshRemote: machine.layer,
      channelsLayer: ChannelLayers.makeLayerServices(settings),
    });
    harness.script.current = remoteScript;
    return { machine, harness };
  };

  it.effect("starts Slack work there with the connection's model, under the link's ceiling", () => {
    const { machine, harness } = defaultsHarness({ modelSelection: slackModel });
    machine.offeredModels = [
      { instance: "codex", model: "slack-default" },
      { instance: "codex", model: "remote-default" },
    ];
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "d1"), slackContext);
      yield* until("running", (task) => task.status === "running");
      const launch = machine.launches[0]!;
      assert.deepStrictEqual(launch.modelSelection, slackModel);
      // The default picks a model, never more authority.
      assert.strictEqual(launch.callerRuntimeMode, "auto-accept-edits");
      assert.strictEqual(launch.runtimeMode, "auto-accept-edits");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks until the requester names a project when the default one is gone", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "d4"), slackContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.include(asked.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      // The other machine has exactly one project; it still was not chosen for them.
      assert.strictEqual(machine.launches.length, 0);
      // An answer that names none of its projects is asked again, not filled in.
      yield* gateway.ingest(slackInput("answer: missing-repo", "d5"), slackContext);
      yield* until(
        "asked again",
        (task) =>
          task.status === "waiting_input" &&
          task.openQuestions[0]?.questionId !== asked.openQuestions[0]?.questionId,
      );
      assert.strictEqual(machine.launches.length, 0);
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "d6"), slackContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reuses the chosen remote project when an unreachable question names none", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "c1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      // The project is chosen, then the machine stops answering before the launch.
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "c2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.environmentReadDown = false;
      yield* gateway.ingest(slackInput("answer: try again", "c3"), slackContext);
      yield* until("running", (task) => task.status === "running" && task.version > second.version);
      assert.strictEqual(machine.launches[0]!.cwd, "/Users/jun/developer/goat-si/goat");
      assert.strictEqual(machine.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks again when the remembered remote project was removed", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "removed1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "removed2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.projects = [
        { ...machine.projects[0]!, id: "remote-project:replacement", title: "Replacement" },
      ];
      machine.environmentReadDown = false;
      yield* gateway.ingest(slackInput("answer: try again", "removed3"), slackContext);
      const asked = yield* until(
        "project removed",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      assert.include(asked.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("remembers the newer remote project by id after its title changes", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    machine.projects.push({
      ...machine.projects[0]!,
      id: "remote-project:other",
      title: "Other",
      workspaceRoot: "/other",
    });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "override1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "override2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      yield* gateway.ingest(slackInput("answer: Other", "override3"), slackContext);
      const third = yield* until(
        "newer choice",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      machine.projects[1] = { ...machine.projects[1]!, title: "Renamed" };
      machine.environmentReadDown = false;
      yield* gateway.ingest(slackInput("answer: try again", "override4"), slackContext);
      yield* until("running", (task) => task.status === "running" && task.version > third.version);
      assert.strictEqual(machine.launches[0]!.cwd, "/other");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks again in a retried generation instead of reusing an earlier choice", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "g1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      // Generation 1 picks a project, then the machine fails before the launch.
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "g2"), slackContext);
      yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      const ledger = yield* ChannelLedger.ChannelLedger;
      const waiting = (yield* ledger.getTask((yield* onlyTask).taskId))!;
      const cancelled = yield* commitTransition(ledger, waiting, {
        type: "task.cancelled",
        payload: { reason: "Starting over." },
      });
      machine.environmentReadDown = false;
      yield* commitTransition(ledger, (yield* ledger.getTask(cancelled!.taskId))!, {
        type: "task.retry.requested",
        payload: { generation: 2 },
      });
      // Generation 2 asks for its own choice; the earlier answer does not launch it.
      const asked = yield* until(
        "asked in generation 2",
        (task) => task.generation === 2 && task.status === "waiting_input",
      );
      assert.include(asked.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "g3"), slackContext);
      yield* until("running", (task) => task.generation === 2 && task.status === "running");
      assert.strictEqual(machine.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not carry a project choice past an answer that picks the machine", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "m1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "m2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.environmentReadDown = false;
      // Picking the machine again starts a new destination; the earlier project answer was for
      // the old one, so the project is asked for again.
      yield* gateway.ingest(slackInput("answer: use mac-studio", "m3"), slackContext);
      const third = yield* until(
        "asked for the project",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      assert.include(third.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "m4"), slackContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not reuse a project on a different host, even with the same project id", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "host1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "host2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.host = "second-host";
      machine.environmentReadDown = false;
      yield* gateway.ingest(slackInput("answer: use second-host", "host3"), slackContext);
      const third = yield* until(
        "new host",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      assert.strictEqual(third.host, "second-host");
      yield* gateway.ingest(slackInput("answer: try again", "host4"), slackContext);
      const fourth = yield* until(
        "new host still needs project",
        (task) => task.status === "waiting_input" && task.version > third.version,
      );
      assert.include(fourth.openQuestions[0]?.text ?? "", "Which project on second-host");
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lets a newer choice of a project here end an older remote project answer", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    machine.projects = [
      ...machine.projects,
      {
        id: "remote-project:other",
        title: "goat-si/other",
        workspaceRoot: "/Users/jun/developer/goat-si/other",
        repositoryIdentity: { canonicalKey: "github.com/goat-si/other" },
        defaultModelSelection: null,
      },
    ];
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "l1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "l2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.environmentReadDown = false;
      // A project on this machine with no counterpart there is the newer choice; the earlier
      // remote answer does not stand in for it.
      yield* gateway.ingest(slackInput("answer: Channel work", "l3"), slackContext);
      const third = yield* until(
        "asked for a project there",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      assert.include(third.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
      yield* gateway.ingest(slackInput("answer: goat-si/other", "l4"), slackContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches[0]!.cwd, "/Users/jun/developer/goat-si/other");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lets a project here picked by id end an older remote project answer", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    machine.projects = [
      ...machine.projects,
      {
        id: "remote-project:other",
        title: "goat-si/other",
        workspaceRoot: "/Users/jun/developer/goat-si/other",
        repositoryIdentity: { canonicalKey: "github.com/goat-si/other" },
        defaultModelSelection: null,
      },
    ];
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "i1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "i2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.environmentReadDown = false;
      yield* gateway.ingest(slackInput("answer: project:channel-work", "i3"), slackContext);
      const third = yield* until(
        "asked for a project there",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      assert.strictEqual(third.projectId, "project:channel-work");
      assert.include(third.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks when the project chosen here was deleted after an older remote answer", () => {
    const { machine, harness } = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    machine.projects = [
      ...machine.projects,
      {
        id: "remote-project:other",
        title: "goat-si/other",
        workspaceRoot: "/Users/jun/developer/goat-si/other",
        repositoryIdentity: { canonicalKey: "github.com/goat-si/other" },
        defaultModelSelection: null,
      },
    ];
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "x1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "x2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.down = true;
      yield* gateway.ingest(slackInput("answer: project:channel-work", "x3"), slackContext);
      const third = yield* until(
        "unreachable again",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      assert.strictEqual(third.projectId, "project:channel-work");
      // The project chosen here disappears from this machine's catalog.
      harness.removeProject(ProjectId.make("project:channel-work"));
      machine.down = false;
      machine.environmentReadDown = false;
      yield* gateway.ingest(slackInput("answer: try again", "x4"), slackContext);
      const fourth = yield* until(
        "asked for a project there",
        (task) => task.status === "waiting_input" && task.version > third.version,
      );
      assert.include(fourth.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  const withOther = (machine: RemoteMachine) => {
    machine.projects = [
      ...machine.projects,
      {
        id: "remote-project:other",
        title: "goat-si/other",
        workspaceRoot: "/Users/jun/developer/goat-si/other",
        repositoryIdentity: { canonicalKey: "github.com/goat-si/other" },
        defaultModelSelection: null,
      },
    ];
  };

  /** A, then a newer choice while the machine is down, then the catalog changes, then "try again". */
  const newerChoiceThenCatalogChange = (
    newer: string,
    change: (h: ReturnType<typeof defaultsHarness>) => void,
  ) => {
    const context = defaultsHarness({ projectId: ProjectId.make("project:deleted") });
    const { machine, harness } = context;
    withOther(machine);
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "z1"), slackContext);
      const first = yield* until("asked", (task) => task.status === "waiting_input");
      machine.environmentReadDown = true;
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "z2"), slackContext);
      const second = yield* until(
        "unreachable",
        (task) => task.status === "waiting_input" && task.version > first.version,
      );
      machine.down = true;
      yield* gateway.ingest(slackInput("answer: " + newer, "z3"), slackContext);
      const third = yield* until(
        "unreachable again",
        (task) => task.status === "waiting_input" && task.version > second.version,
      );
      change(context);
      machine.down = false;
      machine.environmentReadDown = false;
      yield* gateway.ingest(slackInput("answer: try again", "z4"), slackContext);
      const fourth = yield* until(
        "asked for a project there",
        (task) => task.status === "waiting_input" && task.version > third.version,
      );
      assert.include(fourth.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  };

  it.effect("asks when the project chosen here was renamed after an older remote answer", () =>
    newerChoiceThenCatalogChange("Channel work", ({ harness }) =>
      harness.renameProject(ProjectId.make("project:channel-work"), "Renamed work"),
    ),
  );

  it.effect("asks when the newer remote project was removed there", () =>
    newerChoiceThenCatalogChange("goat-si/other", ({ machine }) => {
      machine.projects = machine.projects.filter(
        (project) => project.id !== "remote-project:other",
      );
      machine.projects = [
        ...machine.projects,
        {
          id: "remote-project:third",
          title: "goat-si/third",
          workspaceRoot: "/Users/jun/developer/goat-si/third",
          repositoryIdentity: { canonicalKey: "github.com/goat-si/third" },
          defaultModelSelection: null,
        },
      ];
    }),
  );

  it.effect("does not let the remote's only project stand in for a project named here", () => {
    const { machine, harness } = defaultsHarness({});
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      // A local project (no counterpart there by title or repository) named with the work.
      harness.script.current = (input) =>
        input.mode === "input" && (input.inputText ?? "").startsWith("do@")
          ? Effect.succeed({
              replyText: "On it.",
              action: {
                type: "create_task" as const,
                title: "build it",
                instruction: "build it",
                host: "mac-studio",
                projectId: ProjectId.make("project:channel-work"),
              },
            })
          : remoteScript(input);
      yield* gateway.ingest(
        slackInput("do@mac-studio: build it in Channel work", "n1"),
        slackContext,
      );
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.include(asked.openQuestions[0]?.text ?? "", "Which project on mac-studio");
      assert.strictEqual(machine.launches.length, 0);
      yield* gateway.ingest(slackInput("answer: goat-si/goat", "n2"), slackContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the remote project's model without a Slack default", () => {
    const { machine, harness } = defaultsHarness({});
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "d2"), slackContext);
      yield* until("running", (task) => task.status === "running");
      assert.deepStrictEqual(machine.launches[0]!.modelSelection, remoteModel);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "runs Slack work on the project's model when that machine cannot list its models",
    () => {
      // An older GOAT refuses orchestrator_capabilities: the preference cannot be confirmed.
      const { machine, harness } = defaultsHarness({ modelSelection: slackModel });
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(slackInput("do@mac-studio: build it", "d6"), slackContext);
        yield* until("running", (task) => task.status === "running");
        assert.deepStrictEqual(machine.launches[0]!.modelSelection, remoteModel);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("ignores Slack defaults for work from the GOAT bot", () => {
    const { machine, harness } = defaultsHarness({ modelSelection: slackModel });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: build it", "d3"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      assert.deepStrictEqual(machine.launches[0]!.modelSelection, remoteModel);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "runs Slack work on the project's model when that machine lacks the connection's model",
    () => {
      const { machine, harness } = defaultsHarness({ modelSelection: slackModel });
      machine.offeredModels = [{ instance: "codex", model: "remote-default" }];
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(slackInput("do@mac-studio: build it", "d4"), slackContext);
        yield* until("running", (task) => task.status === "running");
        assert.deepStrictEqual(machine.launches[0]!.modelSelection, remoteModel);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("asks when neither the connection's model nor the project's is offered there", () => {
    const { machine, harness } = defaultsHarness({ modelSelection: slackModel });
    machine.offeredModels = [{ instance: "codex", model: "something-else" }];
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(slackInput("do@mac-studio: build it", "d5"), slackContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.projectModelMissing(machine.host, "goat-si/goat"),
      );
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("models the other machine offers", () => {
  it.effect("asks before launching when that machine lacks this machine's default model", () => {
    const { machine, harness } = remoteHarness();
    machine.offeredModels = [{ instance: "codex", model: "something-else" }];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: needs a model", "mm1"), rpcContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.defaultModelMissing(machine.host, "goat-si/goat"),
      );
      assert.strictEqual(machine.launches.length, 0);
      // Once that machine offers it, the answer sends the work there.
      machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
      yield* gateway.ingest(goatInput("answer: try again", "mm2"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("points to the project's model on that machine when it is missing there", () => {
    const { machine, harness } = remoteHarness();
    machine.projects = machine.projects.map((project) => ({
      ...project,
      defaultModelSelection: { instanceId: "codex", model: "retired-model" } as never,
    }));
    machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: old model", "mm3"), rpcContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.projectModelMissing(machine.host, "goat-si/goat"),
      );
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "asks instead of launching unchecked when that machine's models cannot be read now",
    () => {
      const { machine, harness } = remoteHarness();
      machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
      machine.capabilitiesUnreachable = true;
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(goatInput("do@mac-studio: flaky catalog", "mm4"), rpcContext);
        const asked = yield* until("asked", (task) => task.status === "waiting_input");
        assert.strictEqual(asked.openQuestions[0]?.text, REMOTE_COPY.unreachable(machine.host));
        assert.strictEqual(machine.launches.length, 0);
        machine.capabilitiesUnreachable = false;
        yield* gateway.ingest(goatInput("answer: try again", "mm5"), rpcContext);
        yield* until("running", (task) => task.status === "running");
        assert.strictEqual(machine.launches.length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("reuses the remote project after a model question that names none", () => {
    const { machine, harness } = remoteHarness();
    machine.projects = [
      ...machine.projects,
      {
        id: "remote-project:other",
        title: "other",
        workspaceRoot: "/Users/jun/developer/other",
        repositoryIdentity: null,
        defaultModelSelection: null,
      } as never,
    ];
    machine.offeredModels = [{ instance: "codex", model: "something-else" }];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: two projects", "mm6"), rpcContext);
      yield* until("which project", (task) => task.status === "waiting_input");
      yield* gateway.ingest(goatInput("answer: goat-si/goat", "mm7"), rpcContext);
      const asked = yield* until(
        "model question",
        (task) =>
          task.status === "waiting_input" &&
          task.openQuestions[0]?.text ===
            REMOTE_COPY.defaultModelMissing(machine.host, "goat-si/goat"),
      );
      assert.isDefined(asked);
      machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
      yield* gateway.ingest(goatInput("answer: try again", "mm8"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches[0]!.cwd, "/Users/jun/developer/goat-si/goat");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("what a worker on another machine is told", () => {
  it.effect(
    "carries this machine's GOAT Bot notes, the named skill, and the same safety rules",
    () => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
        yield* fs.makeDirectory(files.skills, { recursive: true });
        yield* fs.writeFileString(files.notes, "- 2026-10-17: open PRs as drafts (asked in x)\n");
        yield* fs.writeFileString(
          path.join(files.skills, "deploy-staging.md"),
          "# Deploy staging\nRun the deploy script, then check the health page.\n",
        );
        yield* fs.writeFileString(path.join(files.skills, "unrelated.md"), "# Unrelated\n");
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(
          slackInput("do@mac-studio: ship it with deploy-staging", "notes-remote"),
          slackContext,
        );
        yield* until("running", (task) => task.status === "running");
        const message = machine.launches[0]?.message ?? "";
        assert.include(message, "<goat_bot_notes>\n- 2026-10-17: open PRs as drafts (asked in x)");
        assert.include(message, '<goat_bot_skill name="deploy-staging">\n# Deploy staging');
        assert.notInclude(message, "Unrelated");
        assert.include(message, "ask first: show the draft or plan in a needs_input report.");
        assert.include(message, "goat_origin_report with status progress");
        // The home machine's paths mean nothing over there.
        assert.notInclude(message, files.notes);
        const ledger = yield* ChannelLedger.ChannelLedger;
        const brief = yield* ledger.latestTaskBrief((yield* onlyTask).taskId);
        assert.strictEqual(
          brief?.context.notesRevision,
          sha256("- 2026-10-17: open PRs as drafts (asked in x)\n"),
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("which account runs work on another machine", () => {
  it.effect("uses another account there when the configured one is at its limit", () => {
    const { machine, harness } = remoteHarness();
    machine.offeredModels = [
      { instance: "codex", model: "gpt-6.1-sol" },
      { instance: "codex-work", model: "gpt-6.1-sol" },
    ];
    machine.hostQuotas = { codex: 100, "codex-work": 15 };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: heavy work", "placement-remote"), rpcContext);
      const running = yield* until("running", (task) => task.status === "running");
      // Only the account changes; the model and its options go along unchanged.
      const launched = machine.launches[0]?.modelSelection;
      assert.strictEqual(launched?.instanceId, ProviderInstanceId.make("codex-work"));
      assert.strictEqual(launched?.model, "gpt-6.1-sol");
      assert.strictEqual(
        running.target?.placementReason,
        "codex-work · 15% weekly used · codex at usage limit",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("says so when the only account there is at its limit, and still runs there", () => {
    const { machine, harness } = remoteHarness();
    machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
    machine.hostQuotas = { codex: 100 };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: still go", "placement-full"), rpcContext);
      const running = yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches[0]?.modelSelection?.instanceId, "codex");
      assert.strictEqual(running.target?.placementReason, "codex · at its usage limit");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "keeps the configured account, without a reason, when that machine reports no quota",
    () => {
      const { machine, harness } = remoteHarness();
      machine.offeredModels = [
        { instance: "codex", model: "gpt-6.1-sol" },
        { instance: "codex-work", model: "gpt-6.1-sol" },
      ];
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        yield* gateway.ingest(
          goatInput("do@mac-studio: older goat", "placement-unknown"),
          rpcContext,
        );
        const running = yield* until("running", (task) => task.status === "running");
        assert.strictEqual(machine.launches[0]?.modelSelection?.instanceId, "codex");
        assert.isUndefined(running.target?.placementReason);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("never moves work to an account there that cannot run it", () => {
    const { machine, harness } = remoteHarness();
    machine.offeredModels = [
      { instance: "codex", model: "gpt-6.1-sol" },
      { instance: "codex-signed-out", model: "gpt-6.1-sol" },
    ];
    machine.unrunnable = ["codex-signed-out"];
    // The signed-out account reports no quota, which alone would score it below 80%.
    machine.hostQuotas = { codex: 80 };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(
        goatInput("do@mac-studio: busy there", "placement-unrunnable"),
        rpcContext,
      );
      const running = yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches[0]?.modelSelection?.instanceId, "codex");
      assert.strictEqual(running.target?.placementReason, "codex · 80% weekly used");
    }).pipe(Effect.provide(harness.layer));
  });
});

it.effect("freezes a remote brief before the SSH launch accepts the worker", () => {
  const { machine, harness } = remoteHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: "remote-brief-owner", now, staleBefore: now });
    const input = yield* gateway.ingest(
      goatInput("do@mac-studio: inspect the remote build", "remote-brief"),
      rpcContext,
    );
    yield* reception.receive(input.inputId, "remote-brief-owner");
    const task = yield* onlyTask;
    const accepted = yield* Deferred.make<void>();
    machine.beforeLaunch = (launch) =>
      Effect.gen(function* () {
        const stored = (yield* ledger.getTask(task.taskId))!;
        const brief = yield* ledger.latestTaskBrief(task.taskId);
        assert.strictEqual(stored.task.status, "dispatching");
        assert.strictEqual(stored.task.briefVersion, 1);
        assert.strictEqual(brief?.instruction, "inspect the remote build");
        assert.strictEqual(brief?.target.hostId, "mac-studio");
        assert.isNull(brief?.context.notesRevision);
        assert.strictEqual(brief?.target.environmentId, machine.environmentId);
        assert.strictEqual(brief?.generation, task.generation);
        assert.strictEqual(brief?.deliveredText, launch.message);
        assert.isTrue(brief?.deliveredText.startsWith(task.instruction));
      }).pipe(
        Effect.orDie,
        Effect.onExit((exit) => Deferred.done(accepted, exit)),
      );
    yield* dispatcher.dispatch(task.taskId, "remote-brief-owner");
    yield* Deferred.await(accepted);
    // The launch records its exact message immediately after the beforeLaunch observation.
    // Read the frozen record here; the launch itself is intentionally asynchronous.
    const brief = yield* ledger.latestTaskBrief(task.taskId);
    assert.strictEqual(brief?.version, 1);
  }).pipe(Effect.provide(harness.layer));
});

describe("stopping a worker on another machine", () => {
  const stopRunningRemote = (machine: RemoteMachine) =>
    Effect.gen(function* () {
      const writes = yield* channelWriteMilestones;
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do@mac-studio: keep going", "remote-stop"), rpcContext);
      yield* runtime.drain;
      const running = yield* writes.waitFor(
        (task) => task.status === "running" && task.worker?.threadId !== undefined,
      );
      yield* Deferred.await(machine.waitIdle);
      const cancelled = yield* commitTransition(
        ledger,
        (yield* ledger.getTask(running.taskId))!,
        { type: "task.cancelled", payload: { reason: "Stopped by the person." } },
        { owner: runtime.ownerToken, forward: true },
      );
      assert.isDefined(cancelled);
      const pending = (yield* ledger.listPendingForwards(10)).find(
        (event) => event.event.type === "task.cancelled",
      );
      assert.isDefined(pending);
      yield* (yield* ChannelRemoteWorkers).stop(pending!, runtime.ownerToken);
      yield* writes.waitForForward(pending!.sequence);
      return { running, pending: pending!, ledger };
    });

  it.effect(
    "stops the remote thread with stopCascade and finishes when the answer omits it",
    () => {
      const { machine, harness } = remoteHarness();
      return Effect.gen(function* () {
        const { running, pending, ledger } = yield* stopRunningRemote(machine);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
        assert.strictEqual((yield* onlyTask).status, "cancelled");
        assert.lengthOf(machine.interrupts, 1);
        assert.deepStrictEqual(machine.interrupts[0], {
          threadId: running.worker?.threadId,
          reason: "Stopped from GOAT Bot.",
          clientRequestId: "channel-stop:" + pending.event.eventId,
          stopCascade: true,
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "interrupts an older remote that refuses stopCascade and still finishes the stop",
    () => {
      const { machine, harness } = remoteHarness();
      machine.refuseStopCascade = true;
      const logs: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        logs.push(JSON.stringify(message));
      });
      return Effect.gen(function* () {
        const { running, pending, ledger } = yield* stopRunningRemote(machine);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
        assert.strictEqual((yield* onlyTask).status, "cancelled");
        assert.lengthOf(machine.interrupts, 2);
        assert.strictEqual(machine.interrupts[0]?.stopCascade, true);
        assert.strictEqual(machine.interrupts[0]?.threadId, running.worker?.threadId);
        assert.strictEqual(
          machine.interrupts[0]?.clientRequestId,
          "channel-stop:" + pending.event.eventId,
        );
        assert.isUndefined(machine.interrupts[1]?.stopCascade);
        assert.strictEqual(machine.interrupts[1]?.threadId, running.worker?.threadId);
        assert.strictEqual(
          machine.interrupts[1]?.clientRequestId,
          machine.interrupts[0]?.clientRequestId,
        );
        assert.include(logs.join("\n"), "remote GOAT cannot stop subagents");
      }).pipe(
        Effect.provide(
          Layer.merge(harness.layer, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    },
  );
});

const autoPlacementHarness = (enabled = true, localUsed = 80, projects = 1) => {
  const machine = new RemoteMachine();
  machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
  machine.hostQuotas = { codex: 20 };
  const harness = makeHarness({
    sshRemote: machine.layer,
    projects,
    repositoryIdentity: {
      canonicalKey: "github.com/goat-si/goat",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/goat-si/goat.git",
      },
    },
    settingsLayer: ServerSettings.layerTest({
      channelAutoPlacement: enabled,
      textGenerationModelSelection: modelSelection,
    }).pipe(Layer.orDie),
    providerInstances: [
      { instanceId: "codex", displayName: "Local Codex", weeklyUsedPercent: localUsed },
    ],
  });
  harness.script.current = remoteScript;
  return { machine, harness };
};

const receivePlacementTask = (key: string, text = "do: inspect the build") =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: "placement-owner", now, staleBefore: now });
    const input = yield* gateway.ingest(goatInput(text, key), rpcContext);
    yield* reception.receive(input.inputId, "placement-owner");
    return (yield* ledger.listTasksByStatus(["received"])).find(
      (stored) => stored.task.originInputId === input.inputId,
    )!.task;
  });

describe("automatic same-repository placement through the dispatcher", () => {
  it.effect.each(["matching", "other-model", "other-home"] as const)(
    "uses remote pooled quotas only for the matching home and model: %s",
    (scenario) => {
      const { machine, harness } = autoPlacementHarness();
      return Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        machine.hostQuotaPool = {
          schema: "ocx.quota-pool/1",
          producer: { version: "test", role: "standalone", homeId: "remote-home" },
          generatedAt: now,
          providers: [
            {
              provider: "codex",
              accounts: [],
              pooled: {
                windows: [
                  {
                    id: "weekly",
                    kind: "weekly",
                    label: "Weekly",
                    source: "measured",
                    observedAt: now,
                    usedPercent: 95,
                    scopeModel: scenario === "other-model" ? "different-model" : "gpt-6.1-sol",
                  },
                ],
              },
            },
          ],
        };
        if (scenario === "other-home") machine.hostQuotaHomeId = "wrong-home";
        yield* setupBot;
        const milestone = yield* channelWriteMilestones;
        const task = yield* receivePlacementTask("auto-pool-" + scenario);
        yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(
          task.taskId,
          "placement-owner",
        );
        const running = yield* milestone.waitFor(
          (next) => next.status !== "received" && next.status !== "dispatching",
        );
        assert.strictEqual(running.status, "running", JSON.stringify(running.openQuestions));
        if (scenario === "matching") {
          assert.isUndefined(running.host);
          assert.lengthOf(machine.launches, 0);
          assert.lengthOf(harness.world.launches, 1);
        } else {
          assert.strictEqual(running.host, "mac-studio");
          assert.lengthOf(machine.launches, 1);
        }
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect(
    "claims the lower weekly quota host, persists its reason and reuses its worker identity",
    () => {
      const { machine, harness } = autoPlacementHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const milestone = yield* channelWriteMilestones;
        const task = yield* receivePlacementTask("auto-lower-weekly");
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        yield* dispatcher.dispatch(task.taskId, "placement-owner");
        const running = yield* milestone.waitFor(
          (next) => next.status !== "received" && next.status !== "dispatching",
        );
        assert.strictEqual(running.status, "running", JSON.stringify(running.openQuestions));
        assert.strictEqual(running.host, "mac-studio");
        assert.strictEqual(running.target?.modelSelection.model, "gpt-6.1-sol");
        assert.strictEqual(running.target?.modelSelection.instanceId, "codex");
        assert.include(running.target?.placementReason ?? "", "20% weekly used");
        assert.strictEqual(running.worker?.host, running.target?.remote?.host);
        assert.strictEqual(running.worker?.threadId, machine.thread(correlationOf(machine)));
        assert.isTrue(machine.launches[0]?.requireReady);
        assert.isTrue(machine.calls.every((call) => call.requireReady));
        assert.isTrue(
          machine.calls
            .filter(
              (call) =>
                call.tool === "orchestrator_capabilities" || call.tool === "goat_provider_diagnose",
            )
            .every((call) => call.existingSessionOnly),
        );
        const ledger = yield* ChannelLedger.ChannelLedger;
        const claimed = (yield* ledger.listPendingNarrations(50)).find(
          (entry) => entry.event.type === "task.dispatch.claimed",
        )?.event;
        assert.strictEqual(claimed?.type, "task.dispatch.claimed");
        if (claimed?.type === "task.dispatch.claimed")
          assert.deepStrictEqual(claimed.payload.target, running.target);
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        for (const pending of yield* ledger.listPendingNarrations(50))
          yield* reception.narrate(pending, "placement-owner");
        const delivery = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        yield* delivery.deliverDue("placement-owner");
        const chips = (yield* botMessages).turnItems.flatMap((item) =>
          item.type === "notification" && item.ledgerTask !== undefined ? [item.ledgerTask] : [],
        );
        assert.strictEqual(chips.at(-1)?.placementReason, running.target?.placementReason);
        assert.strictEqual(chips.at(-1)?.worker?.host, "mac-studio");
        yield* dispatcher.dispatch(task.taskId, "placement-owner");
        assert.lengthOf(machine.launches, 1);
        assert.lengthOf(harness.world.launches, 0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect("spreads simultaneous claims using the committed host load", () => {
    const { machine, harness } = autoPlacementHarness(true, 45);
    return Effect.gen(function* () {
      yield* setupBot;
      const first = yield* receivePlacementTask("auto-spread-first");
      const second = yield* receivePlacementTask("auto-spread-second");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const claims: ChannelTask[] = [];
      const bothClaimed = yield* Deferred.make<void>();
      const bound: ChannelTask[] = [];
      const bothBound = yield* Deferred.make<void>();
      const observed: { applyTaskEvent: typeof ledger.applyTaskEvent } = ledger;
      const original = observed.applyTaskEvent;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          observed.applyTaskEvent = (input) =>
            original(input).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (input.write.event.type === "task.worker.bound") {
                    bound.push(input.write.next);
                    if (bound.length === 2) yield* Deferred.succeed(bothBound, undefined);
                  }
                  if (input.write.event.type !== "task.dispatch.claimed") return;
                  claims.push(input.write.next);
                  if (claims.length === 2) yield* Deferred.succeed(bothClaimed, undefined);
                }),
              ),
            );
        }),
        () =>
          Effect.sync(() => {
            observed.applyTaskEvent = original;
          }),
      );
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      yield* Effect.all(
        [
          dispatcher.dispatch(first.taskId, "placement-owner"),
          dispatcher.dispatch(second.taskId, "placement-owner"),
        ],
        { concurrency: 2 },
      );
      yield* Deferred.await(bothClaimed);
      yield* Deferred.await(bothBound);
      assert.lengthOf(machine.launches, 1);
      assert.lengthOf(harness.world.launches, 1);
      assert.strictEqual(new Set(bound.map((task) => task.worker?.threadId)).size, 2);
      assert.deepStrictEqual(bound.map((task) => task.worker?.host ?? "local").toSorted(), [
        "local",
        "mac-studio",
      ]);
      assert.deepStrictEqual(
        claims.map((task) => task.host ?? "local"),
        ["mac-studio", "local"],
      );
      assert.include(claims[1]?.target?.placementReason ?? "", "free while others work");
      assert.strictEqual(
        claims[0]?.target?.modelSelection.model,
        claims[1]?.target?.modelSelection.model,
      );
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect.each([
    "disabled",
    "wrong-repository",
    "disconnected",
    "unreachable",
    "unready",
    "wrong-model",
    "missing-capabilities",
    "exhausted",
    "project-disabled",
    "missing-project-policy",
  ] as const)("keeps work local when %s", (scenario) => {
    const { machine, harness } = autoPlacementHarness(scenario !== "disabled");
    if (scenario === "wrong-repository")
      machine.projects[0]!.repositoryIdentity.canonicalKey = "github.com/other/repo";
    if (scenario === "disconnected") machine.connected = false;
    if (scenario === "unreachable") machine.down = true;
    if (scenario === "unready") machine.unrunnable = ["codex"];
    if (scenario === "exhausted") machine.hostQuotas = { codex: 100 };
    if (scenario === "project-disabled") machine.projectDisabled = ["codex"];
    if (scenario === "missing-project-policy") machine.projectPolicyKnown = false;
    if (scenario === "wrong-model")
      machine.offeredModels = [{ instance: "codex", model: "another-model" }];
    if (scenario === "missing-capabilities") machine.offeredModels = undefined;
    return Effect.gen(function* () {
      yield* setupBot;
      const milestone = yield* channelWriteMilestones;
      const task = yield* receivePlacementTask("auto-negative-" + scenario);
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      yield* dispatcher.dispatch(task.taskId, "placement-owner");
      const running = yield* milestone.waitFor(
        (next) => next.status !== "received" && next.status !== "dispatching",
      );
      assert.strictEqual(running.status, "running", JSON.stringify(running.openQuestions));
      assert.isUndefined(running.host);
      assert.isUndefined(running.target?.remote);
      assert.lengthOf(machine.launches, 0);
      assert.lengthOf(harness.world.launches, 1);
      if (scenario === "disabled" || scenario === "disconnected") assert.lengthOf(machine.calls, 0);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("does not block dispatch and abandons a hung probe at its bounded deadline", () => {
    const { machine, harness } = autoPlacementHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const milestone = yield* channelWriteMilestones;
      const entered = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      machine.onProjectList = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(held)),
      );
      const task = yield* receivePlacementTask("auto-hung-probe");
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      // This returns while the probe is held, so other channel work can run.
      yield* dispatcher.dispatch(task.taskId, "placement-owner");
      yield* Deferred.await(entered);
      yield* TestClock.adjust(Duration.seconds(5));
      const running = yield* milestone.waitFor(
        (next) => next.status !== "received" && next.status !== "dispatching",
      );
      assert.strictEqual(running.status, "running", JSON.stringify(running.openQuestions));
      assert.isUndefined(running.host);
      assert.lengthOf(machine.launches, 0);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect.each(["unready", "project-disabled"] as const)(
    "keeps an explicitly named host pinned while excluding %s",
    (scenario) => {
      const { machine, harness } = autoPlacementHarness(true, 0);
      machine.offeredModels = [
        { instance: "codex", model: "gpt-6.1-sol" },
        { instance: "codex-ready", model: "gpt-6.1-sol" },
      ];
      if (scenario === "unready") machine.unrunnable = ["codex"];
      else machine.projectDisabled = ["codex"];
      machine.hostQuotas = { codex: 0, "codex-ready": 90 };
      return Effect.gen(function* () {
        yield* setupBot;
        const milestone = yield* channelWriteMilestones;
        const task = yield* receivePlacementTask("auto-pinned", "do@mac-studio: inspect the build");
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        yield* dispatcher.dispatch(task.taskId, "placement-owner");
        const running = yield* milestone.waitFor(
          (next) => next.status !== "received" && next.status !== "dispatching",
        );
        assert.strictEqual(running.status, "running", JSON.stringify(running.openQuestions));
        assert.strictEqual(running.host, "mac-studio");
        assert.strictEqual(running.target?.modelSelection.instanceId, "codex-ready");
        assert.isUndefined(running.target?.remote?.automatic);
        assert.lengthOf(harness.world.launches, 0);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );
});

it.effect("rechecks a revoked channel grant after automatic discovery and before claim", () => {
  const { machine, harness } = autoPlacementHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const milestone = yield* channelWriteMilestones;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: "placement-owner", now, staleBefore: now });
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    machine.onProjectList = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const input = yield* gateway.ingest(
      slackInput("do: inspect permission", "auto-revoked"),
      slackContext,
    );
    yield* reception.receive(input.inputId, "placement-owner");
    const task = yield* onlyTask;
    yield* dispatcher.dispatch(task.taskId, "placement-owner");
    yield* Deferred.await(entered);
    yield* ledger.unlinkIdentity({ connectionId: "slack-1", externalActorId: "U1" });
    yield* Deferred.succeed(release, undefined);
    const failed = yield* milestone.waitFor((next) => next.status === "failed");
    assert.isUndefined(failed.target);
    assert.include(failed.resultSummary ?? "", "permission");
    assert.lengthOf(machine.launches, 0);
    assert.lengthOf(harness.world.launches, 0);
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
});

it.effect(
  "a fresh remote worker service recovers an automatic ambiguous launch without choosing again",
  () => {
    const { machine, harness } = autoPlacementHarness();
    machine.loseNextLaunchAnswer = true;
    return Effect.gen(function* () {
      yield* setupBot;
      const milestone = yield* channelWriteMilestones;
      const task = yield* receivePlacementTask("auto-restart-ambiguous");
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      yield* dispatcher.dispatch(task.taskId, "placement-owner");
      yield* Deferred.await(machine.launchAnswerLost);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const claimed = (yield* ledger.getTask(task.taskId))!.task;
      assert.strictEqual(claimed.status, "dispatching");
      assert.strictEqual(claimed.host, "mac-studio");
      machine.hostQuotas = { codex: 100 };
      const restored = yield* Layer.build(Layer.fresh(remoteWorkersLayer)).pipe(
        Effect.provide(machine.layer),
      );
      yield* Context.get(restored, ChannelRemoteWorkers).launch(task.taskId, "placement-owner");
      const running = yield* milestone.waitFor((next) => next.status === "running");
      assert.deepStrictEqual(running.target, claimed.target);
      assert.strictEqual(running.worker?.threadId, machine.thread(correlationOf(machine)));
      assert.lengthOf(machine.launches, 1);
      assert.strictEqual(machine.threads.size, 1);
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  },
);

it.effect("automatic project questions retain their selectable choices", () => {
  const { machine, harness } = autoPlacementHarness(true, 80, 2);
  return Effect.gen(function* () {
    yield* setupBot;
    const milestone = yield* channelWriteMilestones;
    const task = yield* receivePlacementTask("auto-project-choices");
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, "placement-owner");
    const waiting = yield* milestone.waitFor((next) => next.status === "waiting_input");
    expect(waiting.openQuestions[0]?.options).toEqual(["Channel work", "Other work 1"]);
    assert.lengthOf(machine.calls, 0);
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
});

it.effect("workerless questions do not consume automatic worker slots", () => {
  const { machine, harness } = autoPlacementHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const ledger = yield* ChannelLedger.ChannelLedger;
    for (const key of ["one", "two", "three", "four"]) {
      const task = yield* receivePlacementTask("question-" + key);
      const stored = (yield* ledger.getTask(task.taskId))!;
      yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.question.opened",
          payload: {
            question: {
              questionId: ChannelQuestionId.make("question:" + key),
              text: "Which project?",
              askedAt: DateTime.formatIso(yield* DateTime.now),
            },
          },
        },
        { owner: "placement-owner" },
      );
    }
    const task = yield* receivePlacementTask("auto-after-four-questions");
    const milestone = yield* taskWriteMilestones(task.taskId);
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, "placement-owner");
    const running = yield* milestone.waitFor((next) => next.status === "running");
    assert.strictEqual(running.host, "mac-studio");
    assert.lengthOf(machine.launches, 1);
    assert.strictEqual((yield* ledger.listTasksByStatus(["waiting_input"])).length, 4);
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
});

it.effect("bounds an unreachable automatic claim even before its first launch attempt", () => {
  const { machine, harness } = autoPlacementHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const task = yield* receivePlacementTask("auto-before-first-attempt");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const milestones = yield* taskWriteMilestones(task.taskId);
    const observed: { applyTaskEvent: typeof ledger.applyTaskEvent } = ledger;
    const original = observed.applyTaskEvent;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        observed.applyTaskEvent = (input) =>
          original(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (input.write.event.type === "task.dispatch.claimed") machine.down = true;
              }),
            ),
          );
      }),
      () =>
        Effect.sync(() => {
          observed.applyTaskEvent = original;
        }),
    );
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, "placement-owner");
    yield* milestones.waitFor(
      (next, state) => next.status === "dispatching" && state?.attempts === 0,
    );
    yield* TestClock.adjust(Duration.minutes(6));
    const restarted = yield* Layer.build(Layer.fresh(remoteWorkersLayer)).pipe(
      Effect.provide(machine.layer),
    );
    yield* Context.get(restarted, ChannelRemoteWorkers).launch(task.taskId, "placement-owner");
    const failed = yield* milestones.waitFor((next) => next.status === "failed");
    assert.include(failed.resultSummary ?? "", "can't reach");
    assert.lengthOf(machine.launches, 0);
    assert.lengthOf(harness.world.launches, 0);
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
});

it.effect("refuses a legacy automatic claim without a recorded ceiling before launch", () => {
  const { machine, harness } = autoPlacementHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const task = yield* receivePlacementTask("legacy-claim-ceiling");
    const ledger = yield* ChannelLedger.ChannelLedger;
    const milestones = yield* taskWriteMilestones(task.taskId);
    const observed: { applyTaskEvent: typeof ledger.applyTaskEvent } = ledger;
    const original = observed.applyTaskEvent;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        observed.applyTaskEvent = (input) => {
          const event = input.write.event;
          if (event.type !== "task.dispatch.claimed") return original(input);
          const remote = event.payload.target.remote!;
          const target = {
            ...event.payload.target,
            remote: {
              ...remote,
              automatic: {
                ...remote.automatic!,
                runtimeModeCeiling: undefined,
              },
            },
          };
          return original({
            ...input,
            write: {
              ...input.write,
              next: { ...input.write.next, target },
              event: { ...event, payload: { ...event.payload, target } },
            },
          });
        };
      }),
      () =>
        Effect.sync(() => {
          observed.applyTaskEvent = original;
        }),
    );
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, "placement-owner");
    const failed = yield* milestones.waitFor((next) => next.status === "failed");
    assert.include(failed.resultSummary ?? "", "permission to start this work changed");
    assert.lengthOf(machine.launches, 0);
    assert.lengthOf(harness.world.launches, 0);
    assert.strictEqual(
      yield* ledger.countBusyTasks({
        ownerId: task.requester.ownerId,
        principalId: task.requester.principalId,
      }),
      0,
    );
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
});

it.effect.each(["connection", "ceiling"] as const)(
  "terminates an automatic claim whose durable %s is missing without granting or relaunching",
  (missing) => {
    const { machine, harness } = autoPlacementHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const task = yield* receivePlacementTask("missing-authority-" + missing);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const milestones = yield* taskWriteMilestones(task.taskId);
      const observed: { applyTaskEvent: typeof ledger.applyTaskEvent } = ledger;
      const original = observed.applyTaskEvent;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          observed.applyTaskEvent = (input) =>
            original(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (input.write.event.type === "task.dispatch.claimed") machine.down = true;
                }),
              ),
            );
        }),
        () =>
          Effect.sync(() => {
            observed.applyTaskEvent = original;
          }),
      );
      yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, "placement-owner");
      yield* milestones.waitFor(
        (next, state) => next.status === "dispatching" && state?.attempts === 0,
      );
      yield* ledger.updateRemoteWorker({
        owner: "placement-owner",
        now: DateTime.formatIso(yield* DateTime.now),
        update: {
          taskId: task.taskId,
          update: (json) => {
            const state: RemoteWorkerState = JSON.parse(json!);
            return JSON.stringify({
              ...state,
              connection:
                missing === "connection"
                  ? undefined
                  : {
                      ...state.connection,
                      runtimeModeCeiling: undefined,
                    },
            });
          },
        },
      });
      machine.down = false;
      const previousCalls = machine.calls.length;
      yield* TestClock.adjust(Duration.minutes(6));
      const restarted = yield* Layer.build(Layer.fresh(remoteWorkersLayer)).pipe(
        Effect.provide(machine.layer),
      );
      yield* Context.get(restarted, ChannelRemoteWorkers).launch(task.taskId, "placement-owner");
      const failed = yield* milestones.waitFor((next) => next.status === "failed");
      assert.include(failed.resultSummary ?? "", "recorded authority is incomplete");
      assert.strictEqual(machine.calls.length, previousCalls);
      assert.lengthOf(machine.launches, 0);
      assert.lengthOf(harness.world.launches, 0);
      assert.strictEqual(
        yield* ledger.countBusyTasks({
          ownerId: task.requester.ownerId,
          principalId: task.requester.principalId,
        }),
        0,
      );
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  },
);

it.effect.each(
  [
    "revoked",
    "narrowed-memory",
    "lowered-mode",
    "cancelled",
    "stale-generation",
    "changed-host",
    "changed-thread",
    "changed-scope",
    "missing-state",
    "missing-ceiling",
  ].flatMap((scenario) => [
    { scenario, pinned: false },
    ...([
      "revoked",
      "narrowed-memory",
      "lowered-mode",
      "cancelled",
      "stale-generation",
      "changed-host",
      "changed-thread",
    ].includes(scenario)
      ? [{ scenario, pinned: true }]
      : []),
  ]),
)(
  "recovery fails closed for $scenario before the tool request (pinned=$pinned)",
  ({ scenario, pinned }) => {
    const { machine, harness } = autoPlacementHarness();
    machine.loseNextLaunchAnswer = true;
    const memoryOwner = {
      ...owner,
      grantedScopes: [...owner.grantedScopes, "memory:read" as const],
    };
    const memoryContext = { ...slackContext, grantedScopes: memoryOwner.grantedScopes };
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      const link = Effect.fn("test.linkPlacementRequester")(function* (
        key: string,
        memory: boolean,
        runtimeModeCeiling: RuntimeMode,
      ) {
        const { code } = yield* identities.createLink(
          {
            connectionId: "slack-1",
            runtimeModeCeiling,
            grantedScopes: memory ? memoryOwner.grantedScopes : owner.grantedScopes,
          },
          memoryOwner,
        );
        yield* gateway.linkIdentity(
          {
            connectionId: "slack-1",
            externalActorId: "U1",
            code,
            idempotencyKey: key,
            replyAddress: {
              kind: "slack",
              connectionId: "slack-1",
              teamId: "T1",
              channelId: "D1",
              rootTs: "1",
            },
          },
          memoryContext,
        );
      });
      yield* link("initial-" + scenario, true, "auto-accept-edits");
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "placement-owner", now, staleBefore: now });
      const input = yield* gateway.ingest(
        slackInput(
          pinned ? "do@mac-studio: guarded recovery" : "do: guarded recovery",
          "negative-recovery-" + scenario,
        ),
        memoryContext,
      );
      yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
        input.inputId,
        "placement-owner",
      );
      const task = yield* onlyTask;
      yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, "placement-owner");
      yield* Deferred.await(machine.launchAnswerLost);
      const previousCalls = machine.calls.length;
      machine.beforeHostCall = () =>
        Effect.gen(function* () {
          machine.beforeHostCall = undefined;
          if (scenario === "revoked")
            yield* ledger.unlinkIdentity({ connectionId: "slack-1", externalActorId: "U1" });
          else if (scenario === "narrowed-memory")
            yield* link("narrowed", false, "auto-accept-edits");
          else if (scenario === "lowered-mode") yield* link("lowered", true, "approval-required");
          else if (scenario === "cancelled")
            yield* commitTransition(
              ledger,
              (yield* ledger.getTask(task.taskId))!,
              { type: "task.cancelled", payload: { reason: "Stopped" } },
              { owner: "placement-owner" },
            );
          else if (scenario === "stale-generation") {
            yield* commitTransition(
              ledger,
              (yield* ledger.getTask(task.taskId))!,
              {
                type: "task.failed",
                payload: { generation: task.generation, reason: "interrupted" },
              },
              { owner: "placement-owner" },
            );
            yield* commitTransition(
              ledger,
              (yield* ledger.getTask(task.taskId))!,
              { type: "task.retry.requested", payload: { generation: task.generation + 1 } },
              { owner: "placement-owner" },
            );
          } else
            yield* ledger.updateRemoteWorker({
              owner: "placement-owner",
              now,
              update: {
                taskId: task.taskId,
                update: (json) => {
                  const state: RemoteWorkerState = JSON.parse(json!);
                  return JSON.stringify({
                    ...state,
                    ...(scenario === "changed-host" ? { host: "different-host" } : {}),
                    ...(scenario === "changed-thread"
                      ? { remoteThreadId: "different-thread" }
                      : {}),
                    ...(scenario === "changed-scope"
                      ? { connection: { ...state.connection, memoryGrantCeiling: "read_write" } }
                      : {}),
                    ...(scenario === "missing-state" ? { connection: undefined } : {}),
                    ...(scenario === "missing-ceiling"
                      ? { connection: { ...state.connection, runtimeModeCeiling: undefined } }
                      : {}),
                  });
                },
              },
            });
        }).pipe(Effect.orDie);
      const restored = yield* Layer.build(Layer.fresh(remoteWorkersLayer)).pipe(
        Effect.provide(machine.layer),
      );
      yield* Context.get(restored, ChannelRemoteWorkers).launch(task.taskId, "placement-owner");
      yield* Deferred.await(machine.authorizationDenied);
      assert.strictEqual(machine.calls.length, previousCalls);
      assert.lengthOf(machine.launches, 1);
      assert.strictEqual(machine.threads.size, 1);
      assert.lengthOf(harness.world.launches, 0);
      assert.isUndefined((yield* ledger.getTask(task.taskId))?.task.worker);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  },
);

it.effect("automatic recovery refuses a different environment behind the same host alias", () => {
  const { machine, harness } = autoPlacementHarness();
  machine.loseNextLaunchAnswer = true;
  return Effect.gen(function* () {
    yield* setupBot;
    const task = yield* receivePlacementTask("auto-changed-environment");
    const milestones = yield* taskWriteMilestones(task.taskId);
    yield* (yield* ChannelDispatcher.ChannelDispatcher).dispatch(task.taskId, "placement-owner");
    yield* Deferred.await(machine.launchAnswerLost);
    machine.environmentReadId = "environment:replacement";
    const restored = yield* Layer.build(Layer.fresh(remoteWorkersLayer)).pipe(
      Effect.provide(machine.layer),
    );
    yield* Context.get(restored, ChannelRemoteWorkers).launch(task.taskId, "placement-owner");
    const failed = yield* milestones.waitFor((next) => next.status === "failed");
    assert.include(failed.resultSummary ?? "", "identity changed");
    assert.lengthOf(machine.launches, 1);
    assert.isUndefined(failed.worker);
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
});
