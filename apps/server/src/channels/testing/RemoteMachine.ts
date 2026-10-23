// @effect-diagnostics nodeBuiltinImport:off - the fake remote hashes read keys like the real one.
// @effect-diagnostics preferSchemaOverJson:off - fixture change detection and timeout dumps compare raw JSON text.
import * as NodeCrypto from "node:crypto";

import { assert } from "@effect/vitest";
import {
  type QuotaPool,
  type ChannelReceptionInput,
  type ChannelTask,
  type RemoteReportedOutcome,
  type ChannelWorkerObservation,
  type RemoteKnownRun,
  type RemoteObservedRun,
  type RemoteReport,
  type RemoteReportKind,
  type RuntimeMode,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelRuntime from "../ChannelRuntime.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { defaultScript, onlyTask } from "../testkit/ChannelHarness.ts";

interface RemoteRun {
  readonly runId: string;
  status: string;
  summary: string | null;
  reported?: RemoteReportedOutcome | undefined;
  pendingRequestIds?: RemoteObservedRun["pendingRequestIds"];
  observation?: ChannelWorkerObservation;
}

export class RemoteMachine {
  host = "mac-studio";
  readonly environmentId = "environment:mac-studio";
  environmentReadId: string | undefined;
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
  readonly calls: Array<{
    readonly tool: string;
    readonly ceiling: string;
    readonly host: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly existingSessionOnly?: true;
    readonly requireReady?: true;
  }> = [];
  readonly peers: Array<RemoteMachine> = [];
  connected = true;
  projectDisabled: ReadonlyArray<string> = [];
  projectPolicyKnown = true;
  onProjectList: Effect.Effect<void> = Effect.void;
  beforeHostCall: ((call: SshRemoteDispatch.SshHostToolCall) => Effect.Effect<void>) | undefined;
  readonly authorizationDenied = Deferred.makeUnsafe<void>();
  readonly scripts: Array<{
    readonly host: string;
    readonly script: string;
    readonly kind: "capture" | "apply";
  }> = [];
  readonly interrupts: Array<Readonly<Record<string, unknown>>> = [];
  readonly captureFibers: Array<Fiber.Fiber<unknown, unknown>> = [];
  captureOutput = "GOAT_REPLICA_NO_WORKTREE\n";
  applyOutput = "GOAT_REPLICA_APPLIED " + REPLICA_COMMIT + "\n";
  captureGate:
    | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  refuseProbeWith: string | undefined;
  probeAttempted = Deferred.makeUnsafe<void>();
  probeCount = 0;
  refuseInterruptWith: string | undefined;
  /** An older GOAT rejects `stopCascade` before the interrupt runs. */
  refuseStopCascade = false;
  interruptAttempted = Deferred.makeUnsafe<void>();
  scriptDown = false;
  scriptCalled = Deferred.makeUnsafe<void>();
  waitUnavailable = Deferred.makeUnsafe<void>();
  waitIdle = Deferred.makeUnsafe<void>();
  unreachableWaitCount = 0;
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
  readonly launchAnswerLost = Deferred.makeUnsafe<void>();
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
  hostQuotaPool: QuotaPool | undefined;
  hostQuotaHomeId: string | undefined;
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
    const network = this;
    const machineFor = (host: string | undefined) =>
      [network, ...network.peers].find((candidate) => candidate.host === host) ?? network;
    return Layer.succeed(
      SshRemoteDispatch.SshRemoteDispatch,
      SshRemoteDispatch.SshRemoteDispatch.of({
        connectedHosts: Effect.sync(() =>
          [network, ...network.peers]
            .filter((machine) => machine.connected)
            .map((machine) => machine.host),
        ),
        listHosts: () =>
          Effect.sync(() => [
            ...[network, ...network.peers].map((machine) => ({
              alias: machine.host,
              source: "ssh-config" as const,
            })),
            ...network.knownHostsOnly.map((alias) => ({ alias, source: "known-hosts" as const })),
          ]),
        launchThread: <E, R>(
          input: SshRemoteDispatch.SshLaunchInput,
          beforeLaunch: Effect.Effect<void, E, R>,
        ) =>
          Effect.gen(function* () {
            const machine = machineFor(input.host);
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
              yield* Deferred.succeed(machine.launchAnswerLost, undefined);
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
        runHostScript: (input: {
          readonly host: string;
          readonly script: string;
          readonly timeoutMs: number;
        }) =>
          Effect.gen(function* () {
            const machine = machineFor(input.host);
            const kind = input.script.includes("git bundle create") ? "capture" : "apply";
            assert.include(
              input.script,
              kind === "capture" ? "git bundle create" : "git bundle verify",
            );
            machine.scripts.push({ ...input, kind });
            if (kind === "capture")
              machine.captureFibers.push(yield* Effect.withFiberSucceed((fiber) => fiber));
            const unavailable = machine.down || machine.scriptDown;
            const stdout = kind === "capture" ? machine.captureOutput : machine.applyOutput;
            yield* Deferred.succeed(machine.scriptCalled, undefined);
            if (unavailable) return yield* machine.unreachable("script transport down");
            if (kind === "capture" && machine.captureGate !== undefined) {
              yield* Deferred.succeed(machine.captureGate.entered, undefined);
              yield* Deferred.await(machine.captureGate.release);
            }
            return { stdout, stderr: "" };
          }),
        callHostTool: <E, R>(
          call: SshRemoteDispatch.SshHostToolCall,
          authorize: Effect.Effect<RuntimeMode, E, R>,
        ) =>
          Effect.gen(function* () {
            const machine = machineFor(call.host);
            const ceiling = yield* authorize.pipe(
              Effect.tapError(() => Deferred.succeed(machine.authorizationDenied, undefined)),
            );
            if (machine.beforeHostCall !== undefined) yield* machine.beforeHostCall(call);
            const current = yield* authorize.pipe(
              Effect.tapError(() => Deferred.succeed(machine.authorizationDenied, undefined)),
            );
            if (current !== ceiling) return yield* machine.refused("caller_changed");
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            machine.calls.push({
              tool: call.tool,
              ceiling,
              host: call.host,
              arguments: call.arguments,
              ...(call.existingSessionOnly ? { existingSessionOnly: true as const } : {}),
              ...(call.requireReady ? { requireReady: true as const } : {}),
            });
            debugTrail.push(call.tool);
            if (machine.down) {
              if (call.tool === "goat_origin_reports_wait") {
                const failed = machine.waitUnavailable;
                machine.unreachableWaitCount += 1;
                machine.waitUnavailable = Deferred.makeUnsafe<void>();
                yield* Deferred.succeed(failed, undefined);
              }
              return yield* machine.unreachable("down");
            }
            switch (call.tool) {
              case "goat_project_list":
                yield* machine.onProjectList;
                return { projects: machine.projects, nextCursor: null };
              case "goat_environment_read":
                if (machine.environmentReadDown) return yield* machine.unreachable("down");
                return { environmentId: machine.environmentReadId ?? machine.environmentId };
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
              case "goat_provider_diagnose":
                return {
                  diagnoses: [
                    ...new Set(machine.offeredModels?.map((entry) => entry.instance) ?? []),
                  ].map((instanceId) => ({
                    instanceId,
                    ready: !machine.projectDisabled.includes(instanceId),
                    checks: machine.projectPolicyKnown
                      ? [
                          {
                            id: "project_provider",
                            status: machine.projectDisabled.includes(instanceId) ? "fail" : "pass",
                          },
                        ]
                      : [],
                  })),
                };
              case "goat_host_status":
                if (machine.hostQuotas === undefined) break;
                return {
                  hosts: [
                    {
                      host: null,
                      reachability: "ok",
                      metrics: {
                        quotaPool: machine.hostQuotaPool,
                        threads: { running: 0, waiting: 0, queued: 0 },
                        quotas: Object.entries(machine.hostQuotas).map(([instanceId, used]) => ({
                          instanceId,
                          driver: "codex",
                          fromCache: true,
                          limits: {
                            checkedAt,
                            quotaPool:
                              machine.hostQuotaPool === undefined
                                ? undefined
                                : {
                                    provider: "codex",
                                    homeId:
                                      machine.hostQuotaHomeId ??
                                      machine.hostQuotaPool.producer.homeId,
                                  },
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
              case "goat_thread_interrupt": {
                machine.interrupts.push(call.arguments);
                const attempted = machine.interruptAttempted;
                machine.interruptAttempted = Deferred.makeUnsafe<void>();
                const refused = machine.refuseInterruptWith;
                yield* Deferred.succeed(attempted, undefined);
                if (refused !== undefined) return yield* machine.refused(refused);
                // An older GOAT has no stopCascade argument and refuses it before anything runs.
                if (call.arguments.stopCascade === true && machine.refuseStopCascade) {
                  return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                    reason: "remote_refused",
                    message: "goat_thread_interrupt does not take stopCascade, so nothing ran.",
                    remoteCode: "invalid_request",
                  });
                }
                return {};
              }
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
                if (call.arguments.timeoutMs === 0) {
                  machine.probeCount += 1;
                  const attempted = machine.probeAttempted;
                  machine.probeAttempted = Deferred.makeUnsafe<void>();
                  const refused = machine.refuseProbeWith;
                  yield* Deferred.succeed(attempted, undefined);
                  if (refused !== undefined) return yield* machine.refused(refused);
                }
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
                yield* Deferred.succeed(machine.waitIdle, undefined);
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

export const REPLICA_COMMIT = "b".repeat(40);
// The transport fixture need only satisfy the wire parser; no shell or git is run here.
export const REPLICA_BYTES = Buffer.from("worker commits and uncommitted edits\n");
export const replicaOutput = (commitOid: string, bytes: Buffer) =>
  [
    "GOAT_REPLICA_OK",
    "HEAD " + "a".repeat(40),
    "COMMIT " + commitOid,
    "BYTES " + bytes.length,
    "EXCLUDED ",
    "GOAT_REPLICA_BUNDLE_BEGIN",
    bytes.toString("base64"),
    "GOAT_REPLICA_BUNDLE_END",
    "",
  ].join("\n");
export const REPLICA_OUTPUT = replicaOutput(REPLICA_COMMIT, REPLICA_BYTES);

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** "do@host: text" asks for work on host; everything else is the default script. */
export const remoteScript = (input: ChannelReceptionInput) => {
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
export const settle = (rounds = 40, stepMs = 100) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    for (let round = 0; round < rounds; round += 1) {
      yield* runtime.drain;
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(stepMs));
    }
  });

export const until = (label: string, check: (task: ChannelTask) => boolean, rounds = 200) =>
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

export const correlationOf = (machine: RemoteMachine) => [...machine.bindings.keys()].at(-1)!;
