// @effect-diagnostics nodeBuiltinImport:off - the fake remote hashes read keys like the real one.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelReceptionInput,
  type ChannelTask,
  ChannelTaskEvent,
  type RemoteReportedOutcome,
  type ChannelWorkerObservation,
  type RemoteKnownRun,
  type RemoteObservedRun,
  RuntimeRequestId,
  ProjectId,
  EnvironmentId,
  ProviderInstanceId,
  type RemoteReport,
  type RemoteReportKind,
  type RuntimeMode,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { REMOTE_COPY, REMOTE_SETTLE_WAIT_MS } from "./ChannelRemoteWorkers.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  onlyTask,
  resultsTo,
  rpcContext,
  owner,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

/**
 * Tasks on another machine. The other machine is a fake GOAT reached over a fake SSH dispatch:
 * it keeps report bindings (one per correlation id, stored before the thread exists, like the
 * real goat_thread_launch), the reports its worker files with goat_origin_report, and its runs.
 * Tests drive the worker's side and the network; the channel side is the real core.
 */

interface RemoteRun {
  readonly runId: string;
  status: string;
  summary: string | null;
  reported?: RemoteReportedOutcome | undefined;
  pendingRequestIds?: RemoteObservedRun["pendingRequestIds"];
  observation?: ChannelWorkerObservation;
}

class RemoteMachine {
  host = "mac-studio";
  readonly environmentId = "environment:mac-studio";
  projects = [
    {
      id: "remote-project:goat",
      title: "goat-si/goat",
      workspaceRoot: "/Users/jun/developer/goat-si/goat",
      repositoryIdentity: { canonicalKey: "github.com/goat-si/goat" },
      defaultModelSelection: null,
    },
  ];
  readonly bindings = new Map<
    string,
    { readonly threadId: string; readonly readKeyHash: string; last: number }
  >();
  readonly reports = new Map<string, Array<RemoteReport>>();
  readonly threads = new Map<string, Array<RemoteRun>>();
  readonly launches: Array<SshRemoteDispatch.SshLaunchInput> = [];
  readonly sends: Array<Readonly<Record<string, unknown>>> = [];
  readonly calls: Array<{ readonly tool: string; readonly ceiling: string }> = [];
  /** A test observes the persisted brief before SSH accepts the launch. */
  beforeLaunch: ((input: SshRemoteDispatch.SshLaunchInput) => Effect.Effect<void>) | undefined;
  /** While true, every call fails as if SSH could not reach the host. */
  down = false;
  /** While true, only goat_environment_read fails, after the projects were listed. */
  environmentReadDown = false;
  /** Hosts this machine has only seen in known_hosts, never configured. */
  knownHostsOnly: ReadonlyArray<string> = [];
  /** The next launch starts the thread but its answer never arrives. */
  loseNextLaunchAnswer = false;
  /** The worker's old run files a question right after an answer is sent (a late report). */
  staleQuestionOnSend = false;
  /** Answers every wait with all reports ever filed, as if acknowledgements were lost. */
  replayReports = false;
  /** Launch attempts that fail on the wire before the remote stores anything. */
  failBeforeBinding = 0;
  /** The project is deleted there right after a failed launch attempt. */
  dropProjectsOnFailedLaunch = false;
  /** The next launch stores its binding, then its answer is lost before the thread exists. */
  slowThreadCreation = false;
  /** Every launch is refused outright with this text (nothing is stored). */
  refuseLaunchWith: string | undefined;
  refuseLaunchCode = "invalid_request";
  /** Waits on this binding block until `release` completes. */
  holdWaitsFor: string | undefined;
  /** goat_thread_send fails with this remote code. */
  refuseSendWith: string | undefined;
  /** The models orchestrator_capabilities lists; unset, the tool is refused (an older GOAT). */
  offeredModels: ReadonlyArray<{ readonly instance: string; readonly model: string }> | undefined;
  /** orchestrator_capabilities alone cannot be reached (the call times out). */
  capabilitiesUnreachable = false;
  /** Weekly quota use per account that goat_host_status reports; unset, the tool is refused. */
  hostQuotas: Readonly<Record<string, number>> | undefined;
  /** Accounts orchestrator_capabilities lists but reports as unable to run work. */
  unrunnable: ReadonlyArray<string> = [];
  /** goat_thread_send names a run that never exists. */
  sendNamesMissingRun = false;
  /** After the answer's run, another run starts at once and asks this. */
  questionInRunAfterAnswer: string | undefined;
  readonly release = Deferred.makeUnsafe<void>();
  onWait: ((input: Readonly<Record<string, unknown>>) => Effect.Effect<void>) | undefined;
  private readonly pendingThreads = new Map<string, string>();
  private readonly everFiled = new Map<string, Array<RemoteReport>>();
  private changed = Deferred.makeUnsafe<void>();
  private nextThread = 1;

  private poke() {
    const previous = this.changed;
    this.changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  }

  thread(correlationId: string) {
    const binding = this.bindings.get(correlationId);
    if (binding === undefined) throw new Error("no binding " + correlationId);
    return binding.threadId;
  }

  /** The thread a slow launch was creating shows up, with its first run. */
  revealThread(correlationId: string) {
    const threadId = this.pendingThreads.get(correlationId)!;
    this.pendingThreads.delete(correlationId);
    this.threads.set(threadId, []);
    this.startRun(correlationId);
  }

  runs(correlationId: string) {
    return this.threads.get(this.thread(correlationId)) ?? [];
  }

  startRun(correlationId: string) {
    const threadId = this.thread(correlationId);
    const runs = this.threads.get(threadId) ?? [];
    const run = { runId: threadId + ":run:" + (runs.length + 1), status: "running", summary: null };
    this.threads.set(threadId, [...runs, run]);
    this.poke();
    return run.runId;
  }

  finishRun(
    correlationId: string,
    status: string,
    summary: string | null,
    reported?: RemoteReportedOutcome,
  ) {
    const run = this.runs(correlationId).at(-1)!;
    run.status = status;
    run.summary = summary;
    run.reported = reported;
    this.poke();
  }

  /** What holds a finished run's thread open; undefined plays an older GOAT that omits it. */
  holds: { backgroundTasks: number; continuationPending: boolean } | undefined;
  setHolds(holds: { backgroundTasks: number; continuationPending: boolean }) {
    this.holds = holds;
    this.poke();
  }

  observeRun(
    correlationId: string,
    observation: ChannelWorkerObservation,
    pendingRequestIds: RemoteObservedRun["pendingRequestIds"] = [],
  ) {
    const run = this.runs(correlationId).at(-1)!;
    run.observation = observation;
    run.pendingRequestIds = pendingRequestIds;
    this.poke();
  }

  /** The remote long poll reaches its deadline without changing durable state. */
  timeoutWait() {
    this.poke();
  }

  report(correlationId: string, kind: RemoteReportKind, summary: string, runId?: string | null) {
    const binding = this.bindings.get(correlationId)!;
    binding.last += 1;
    const list = this.reports.get(correlationId) ?? [];
    list.push({
      sequence: binding.last,
      runId: (runId === undefined
        ? (this.runs(correlationId).at(-1)?.runId ?? null)
        : runId) as never,
      kind,
      summary,
      createdAt: "2026-10-12T01:00:00.000Z" as never,
    });
    this.reports.set(correlationId, list);
    this.everFiled.set(correlationId, [...(this.everFiled.get(correlationId) ?? []), list.at(-1)!]);
    this.poke();
  }

  unreachable(message: string) {
    return new SshRemoteDispatch.SshRemoteDispatchError({ reason: "host_unavailable", message });
  }

  refused(code: string) {
    return new SshRemoteDispatch.SshRemoteDispatchError({
      reason: "remote_refused",
      message: code,
      remoteCode: code,
    });
  }

  private read(input: Readonly<Record<string, unknown>>) {
    const correlationId = input.correlationId as string;
    const binding = this.bindings.get(correlationId);
    const hash = sha256(input.readKey as string);
    if (binding === undefined || binding.readKeyHash !== hash) {
      return { error: this.refused("capability_denied") } as const;
    }
    const runs = this.threads.get(binding.threadId);
    if (runs === undefined) return { error: this.refused("thread_not_found") } as const;
    const afterSequence = input.afterSequence as number;
    const kept = this.replayReports
      ? (this.everFiled.get(correlationId) ?? [])
      : (this.reports.get(correlationId) ?? []).filter((report) => report.sequence > afterSequence);
    this.reports.set(correlationId, kept);
    const latest = runs.at(-1);
    const watch = (input.watchRunId as string | null) ?? latest?.runId ?? null;
    const run = watch === null ? undefined : runs.find((candidate) => candidate.runId === watch);
    if (watch !== null && run === undefined)
      return { error: this.refused("run_not_found") } as const;
    return {
      value: {
        threadId: binding.threadId,
        reports: kept.slice(0, 50),
        hasMore: kept.length > 50,
        observedRun:
          run === undefined
            ? null
            : {
                runId: run.runId,
                status: run.status,
                summary: TERMINAL.has(run.status) ? run.summary : null,
                ...(TERMINAL.has(run.status) && run.reported !== undefined
                  ? { reported: run.reported }
                  : {}),
                ...(run.pendingRequestIds === undefined
                  ? {}
                  : { pendingRequestIds: run.pendingRequestIds }),
                ...(run.observation === undefined ? {} : { observation: run.observation }),
                ...(TERMINAL.has(run.status) && this.holds !== undefined
                  ? { holds: this.holds }
                  : {}),
              },
        latestRunId: latest?.runId ?? null,
        timedOut: false,
      },
    } as const;
  }

  readonly layer: Layer.Layer<SshRemoteDispatch.SshRemoteDispatch> = this.makeLayer();

  private makeLayer() {
    // oxlint-disable-next-line typescript/no-this-alias -- the fake's handlers close over it.
    const machine = this;
    return Layer.succeed(
      SshRemoteDispatch.SshRemoteDispatch,
      SshRemoteDispatch.SshRemoteDispatch.of({
        listHosts: () =>
          Effect.sync(() => [
            { alias: machine.host, source: "ssh-config" },
            ...machine.knownHostsOnly.map((alias) => ({ alias, source: "known-hosts" as const })),
          ]),
        launchThread: <E, R>(
          input: SshRemoteDispatch.SshLaunchInput,
          beforeLaunch: Effect.Effect<void, E, R>,
        ) =>
          Effect.gen(function* () {
            if (machine.down) return yield* machine.unreachable("down");
            yield* beforeLaunch;
            if (machine.beforeLaunch !== undefined) yield* machine.beforeLaunch(input);
            machine.launches.push(input);
            const report = input.report!;
            if (machine.failBeforeBinding > 0) {
              machine.failBeforeBinding -= 1;
              if (machine.dropProjectsOnFailedLaunch) machine.projects = [];
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "ssh_failed",
                message: "connection reset",
                launchMayHaveStarted: true,
              });
            }
            if (machine.refuseLaunchWith !== undefined) {
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "remote_refused",
                message: machine.refuseLaunchWith,
                remoteCode: machine.refuseLaunchCode,
              });
            }
            if (machine.bindings.has(report.correlationId)) {
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "remote_refused",
                message: "The remote server is unavailable.",
                remoteCode: "orchestration_error",
              });
            }
            const threadId = "remote-thread:" + machine.nextThread++;
            machine.bindings.set(report.correlationId, {
              threadId,
              readKeyHash: report.readKeyHash,
              last: 0,
            });
            if (machine.slowThreadCreation) {
              machine.slowThreadCreation = false;
              machine.pendingThreads.set(report.correlationId, threadId);
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "host_unavailable",
                message: "timed out",
                launchMayHaveStarted: true,
              });
            }
            machine.threads.set(threadId, []);
            const runId = machine.startRun(report.correlationId);
            if (machine.loseNextLaunchAnswer) {
              machine.loseNextLaunchAnswer = false;
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "ssh_failed",
                message: "connection reset",
                launchMayHaveStarted: true,
              });
            }
            return {
              host: machine.host,
              cwd: input.cwd,
              projectId: "remote-project:goat",
              projectCreated: false,
              threadId,
              reportsSupported: true,
              runId,
              workspaceStrategy: { type: "root" },
              runtimeMode: input.runtimeMode,
              remoteServerKind: "managed",
              notes: [],
            } as never;
          }),
        callHostTool: <E, R>(
          call: SshRemoteDispatch.SshHostToolCall,
          authorize: Effect.Effect<RuntimeMode, E, R>,
        ) =>
          Effect.gen(function* () {
            const ceiling = yield* authorize;
            machine.calls.push({ tool: call.tool, ceiling });
            debugTrail.push(call.tool);
            if (machine.down) return yield* machine.unreachable("down");
            switch (call.tool) {
              case "goat_project_list":
                return { projects: machine.projects, nextCursor: null };
              case "goat_environment_read":
                if (machine.environmentReadDown) return yield* machine.unreachable("down");
                return { environmentId: machine.environmentId };
              case "orchestrator_capabilities":
                if (machine.capabilitiesUnreachable) return yield* machine.unreachable("timed out");
                if (machine.offeredModels === undefined) break;
                return {
                  providers: [...new Set(machine.offeredModels.map((entry) => entry.instance))].map(
                    (instance) => ({
                      providerInstanceId: instance,
                      driverKind: "codex",
                      // A real GOAT sends null for an account without a display name.
                      displayName: null,
                      canRunChildTask: !machine.unrunnable.includes(instance),
                      models: machine
                        .offeredModels!.filter((entry) => entry.instance === instance)
                        .map((entry) => ({ id: entry.model })),
                    }),
                  ),
                };
              case "goat_host_status":
                if (machine.hostQuotas === undefined) break;
                return {
                  hosts: [
                    {
                      host: null,
                      reachability: "ok",
                      metrics: {
                        threads: { running: 0, waiting: 0, queued: 0 },
                        quotas: Object.entries(machine.hostQuotas).map(([instanceId, used]) => ({
                          instanceId,
                          driver: "codex",
                          fromCache: true,
                          limits: {
                            checkedAt: "2026-10-17T00:00:00.000Z",
                            windows: [
                              {
                                id: "weekly",
                                kind: "weekly",
                                label: "Weekly",
                                usedPercent: used,
                                resetsAt: "2099-01-01T00:00:00.000Z",
                              },
                            ],
                          },
                        })),
                      },
                    },
                  ],
                };
              case "goat_thread_send": {
                machine.sends.push(call.arguments);
                if (machine.refuseSendWith !== undefined) {
                  return yield* machine.refused(machine.refuseSendWith);
                }
                const threadId = call.arguments.threadId as string;
                const correlationId = [...machine.bindings].find(
                  ([, b]) => b.threadId === threadId,
                )![0];
                const previous = machine.runs(correlationId).at(-1)?.runId ?? null;
                const runId = machine.startRun(correlationId);
                if (machine.staleQuestionOnSend) {
                  machine.report(correlationId, "needs_input", "Stale question?", previous);
                }
                if (machine.questionInRunAfterAnswer !== undefined) {
                  // The answer's run ends at once and a continuation asks again.
                  machine.finishRun(correlationId, "completed", "Handed on.");
                  machine.startRun(correlationId);
                  machine.report(correlationId, "needs_input", machine.questionInRunAfterAnswer);
                }
                if (machine.sendNamesMissingRun) {
                  return { runId: runId + ":missing", messageId: "remote-message" };
                }
                return { runId, messageId: "remote-message" };
              }
              case "goat_origin_reports_wait": {
                if (call.arguments.correlationId === machine.holdWaitsFor) {
                  yield* Deferred.await(machine.release);
                }
                const first = machine.read(call.arguments);
                if ("error" in first) return yield* first.error!;
                const known = call.arguments.knownRun as RemoteKnownRun | null;
                const holds = first.value.observedRun?.holds;
                const changed =
                  first.value.reports.length > 0 ||
                  first.value.observedRun?.runId !== known?.runId ||
                  first.value.observedRun?.status !== known?.status ||
                  (known?.holds !== undefined &&
                    (known.holds.backgroundTasks !== (holds?.backgroundTasks ?? 0) ||
                      known.holds.continuationPending !== (holds?.continuationPending ?? false))) ||
                  (known?.pendingRequestIds !== undefined &&
                    JSON.stringify(known.pendingRequestIds) !==
                      JSON.stringify(first.value.observedRun?.pendingRequestIds ?? [])) ||
                  (known?.observation !== undefined &&
                    JSON.stringify(known.observation) !==
                      JSON.stringify(first.value.observedRun?.observation));
                const timeoutMs = call.arguments.timeoutMs as number;
                const change = machine.changed;
                if (machine.onWait !== undefined) yield* machine.onWait(call.arguments);
                if (changed || timeoutMs === 0) return first.value;
                yield* Effect.raceFirst(
                  Deferred.await(change),
                  Effect.sleep(Duration.millis(timeoutMs)),
                );
                const second = machine.read(call.arguments);
                if ("error" in second) return yield* second.error!;
                return { ...second.value, timedOut: true };
              }
            }
            return yield* machine.refused("invalid_request");
          }),
      } as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"]),
    );
  }
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** "do@host: text" asks for work on host; everything else is the default script. */
const remoteScript = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
  const match = /^do@([^:]+):\s*(.+)$/u.exec(text);
  if (input.mode === "input" && match !== null) {
    return Effect.succeed({
      replyText: "On it.",
      action: {
        type: "create_task" as const,
        title: match[2]!,
        instruction: match[2]!,
        host: match[1]!,
      },
    });
  }
  if (input.mode === "input" && text.startsWith("answer:")) {
    const task = input.tasks.find((candidate) => candidate.openQuestions.length > 0);
    const question = task?.openQuestions[0];
    if (task !== undefined && question !== undefined) {
      return Effect.succeed({
        replyText: "Thanks.",
        action: {
          type: "answer_question" as const,
          taskId: task.taskId,
          questionId: question.questionId,
          answer: text.slice("answer:".length).trim(),
        },
      });
    }
  }
  return defaultScript(input);
};

/** Lets background fibers run, moving the test clock a little each turn. */
const settle = (rounds = 40, stepMs = 100) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    for (let round = 0; round < rounds; round += 1) {
      yield* runtime.drain;
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(stepMs));
    }
  });

const until = (label: string, check: (task: ChannelTask) => boolean, rounds = 200) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round += 1) {
      yield* settle(1);
      const task = yield* onlyTask;
      if (check(task)) return task;
    }
    const task = yield* onlyTask;
    return yield* Effect.die(
      new Error(
        "timed out waiting for " +
          label +
          ": " +
          JSON.stringify({
            status: task.status,
            host: task.host,
            q: task.openQuestions,
            summary: task.resultSummary,
          }) +
          " " +
          JSON.stringify(debugTrail),
      ),
    );
  });

const debugTrail: Array<unknown> = [];

const correlationOf = (machine: RemoteMachine) => [...machine.bindings.keys()].at(-1)!;

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
    return JSON.parse(json ?? "{}") as {
      readonly readKey: string;
      readonly cursor: number;
      readonly knownRun?: RemoteKnownRun;
      readonly settleRunId?: string;
    };
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
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ChannelTaskEvent))(
      rows[0]!.event_json,
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
        assert.isTrue(
          records.messages.some((message) =>
            message.text.includes(REMOTE_COPY.memoryUnsupported(machine.host)),
          ),
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
          NodeCrypto.createHash("sha256")
            .update("- 2026-10-17: open PRs as drafts (asked in x)\n")
            .digest("hex"),
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
