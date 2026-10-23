import * as PressureNudger from "../fleet/pressure/PressureNudger.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  CheckpointId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ProviderInstanceId,
  type ThreadReplicaPayload,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as CompletionWebhook from "./completionWebhook.ts";
import type { LaunchWatch, LaunchWatchWebhookTarget } from "./launchWatch.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";

const launcher = ThreadId.make("launcher");
const target = ThreadId.make("target");
const projectId = ProjectId.make("project");
const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");

type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type WaitAnswer = Effect.Effect<
  ThreadManagementService.ThreadManagementWaitResult,
  ThreadManagementService.ThreadManagementError
>;

/** Everything the service sees of the world, under the test's control. */
interface World {
  readonly shells: Map<string, Partial<OrchestrationV2ThreadShell>>;
  hostReplication?: "on" | "off";
  pressureBlocked?: boolean;
  settings?: ServerSettings.ServerSettingsService["Service"];
  payloadStaged?: Effect.Effect<void>;
  /** Answers to local waits, taken one per wait. */
  readonly waits: Queue.Queue<WaitAnswer>;
  readonly waitCalls: Array<ThreadManagementService.ThreadManagementWaitInput>;
  waitHandler?: (input: ThreadManagementService.ThreadManagementWaitInput) => WaitAnswer;
  /** One entry per wait that started. */
  readonly waitStarted: Queue.Queue<RunId | undefined>;
  /** One entry per read of the launcher's shell. */
  readonly launcherReads: Queue.Queue<void>;
  readonly escalationMessages: Set<string>;
  readonly escalationReads: Array<ReadonlyArray<string>>;
  readonly assistantMessages: Array<{ runId: RunId; text: string }>;
  /** The followed thread's runs and error items, for a run that failed before its agent spoke. */
  runs: Array<Record<string, unknown>>;
  turnItems: Array<Record<string, unknown>>;
  providerThreads: Array<{ cloudTask?: { attach?: string; tracking: string } }>;
  requests: Array<{ id: string; status: string; kind: string }>;
  subagents: Array<{ origin: string; childThreadId: ThreadId }>;
  /** Failures for the next dispatches, used up in order. */
  readonly dispatchFailures: Array<"transient" | "refused">;
  /**
   * Command ids the orchestrator recorded as rejected. Like the real receipt
   * store, a dispatch that fails is recorded, and its id is refused again.
   */
  readonly rejected: Set<string>;
  readonly attempts: Array<Dispatch>;
  readonly delivered: Queue.Queue<Dispatch>;
  readonly deliveredLog: Array<Dispatch>;
  hostCall: (
    call: SshRemoteDispatch.SshHostToolCall,
  ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  readonly hostCalls: Array<{
    call: SshRemoteDispatch.SshHostToolCall;
    ceiling: string;
    at: number;
  }>;
  /** Reports handed to the completion webhook, with the watch they came from. */
  readonly webhookReports: Array<{
    watch: LaunchWatch;
    report: CompletionWebhook.CompletionWebhookReport;
  }>;
  webhookNotify?: Effect.Effect<void>;
  /** What the completion webhook answers when asked to watch an outside launch. */
  webhookWatchesExternal: boolean;
  /** Whether the completion webhook still posts a watch's reports. */
  webhookWants: boolean;
  /** Webhook targets whose kept secret the service released. */
  readonly releasedTargets: Array<LaunchWatchWebhookTarget | null>;
  webhookRelease?: Effect.Effect<void>;
  /** One entry per time the service asked whether the webhook still posts a watch's reports. */
  readonly wantsAsked: Queue.Queue<void>;
}

const makeWorld = Effect.gen(function* () {
  const world: World = {
    shells: new Map([
      [
        launcher,
        {
          id: launcher,
          runtimeMode: "full-access",
          interactionMode: "default",
          archivedAt: null,
          deletedAt: null,
        },
      ],
      [
        target,
        {
          id: target,
          projectId,
          title: "Fix the flake",
          branch: "goat/fix",
          worktreePath: "/work/fix",
          archivedAt: null,
          deletedAt: null,
          creationSource: "mcp",
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: target },
        },
      ],
    ]),
    waits: yield* Queue.unbounded<WaitAnswer>(),
    waitCalls: [],
    waitStarted: yield* Queue.unbounded<RunId | undefined>(),
    launcherReads: yield* Queue.unbounded<void>(),
    escalationMessages: new Set(),
    escalationReads: [],
    assistantMessages: [],
    runs: [],
    turnItems: [],
    providerThreads: [],
    requests: [],
    subagents: [],
    dispatchFailures: [],
    rejected: new Set(),
    attempts: [],
    delivered: yield* Queue.unbounded<Dispatch>(),
    deliveredLog: [],
    hostCall: (call) => Effect.die(new Error("unexpected host call " + call.tool)),
    hostCalls: [],
    webhookReports: [],
    webhookWatchesExternal: true,
    webhookWants: true,
    releasedTargets: [],
    wantsAsked: yield* Queue.unbounded<void>(),
  };
  return world;
});

const dispatchIn = (world: World, command: OrchestrationV2ServerCommand) =>
  Effect.suspend(() => {
    const dispatch = command as Dispatch;
    world.attempts.push(dispatch);
    const commandId = CommandId.make(dispatch.commandId);
    if (world.rejected.has(commandId)) {
      return Effect.fail(
        new OrchestratorCommandPreviouslyRejectedError({
          commandId,
          commandType: dispatch.type,
          detail: "rejected before",
        }),
      );
    }
    const failure = world.dispatchFailures.shift();
    if (failure !== undefined) {
      world.rejected.add(commandId);
      return Effect.fail(
        failure === "transient"
          ? new OrchestratorDispatchError({ commandId, commandType: dispatch.type })
          : new OrchestratorCommandPreviouslyRejectedError({
              commandId,
              commandType: dispatch.type,
              detail: "refused",
            }),
      );
    }
    world.deliveredLog.push(dispatch);
    return Queue.offer(world.delivered, dispatch).pipe(Effect.as({} as never));
  });

const layerFor = (world: World, baseDir: string) =>
  LaunchWatchService.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          fleet: {
            hosts: {
              box:
                world.hostReplication === undefined
                  ? {}
                  : { checkpointReplication: world.hostReplication },
            },
          },
        }).pipe(
          Layer.tap((context) =>
            Effect.sync(() => {
              world.settings = Context.get(context, ServerSettings.ServerSettingsService);
            }),
          ),
        ),
        Layer.mock(PressureNudger.PressureAdmissionService)({
          admit: (host) =>
            Effect.succeed({
              refuse: world.pressureBlocked === true,
              advice: world.pressureBlocked
                ? { host, level: "critical", message: "fixture pressure", alternatives: [] }
                : undefined,
            }),
        }),
        Layer.mock(ThreadReplicaService.ThreadReplicaService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            (threadId === launcher
              ? Queue.offer(world.launcherReads, undefined)
              : Effect.void
            ).pipe(
              Effect.as((world.shells.get(threadId) ?? null) as OrchestrationV2ThreadShell | null),
            ),
          waitForThread: (input) =>
            Effect.suspend(() => {
              world.waitCalls.push(input);
              return Queue.offer(world.waitStarted, input.runId).pipe(
                Effect.andThen(
                  world.waitHandler?.(input) ?? Queue.take(world.waits).pipe(Effect.flatten),
                ),
              );
            }),
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.sync(() => {
              if (filter?.messageIds !== undefined) {
                world.escalationReads.push(filter.messageIds);
                return {
                  messages: filter.messageIds
                    .filter((id) => world.escalationMessages.has(id))
                    .map((id) => ({ id })),
                } as never;
              }
              return {
                thread: {},
                messages: world.assistantMessages
                  .filter((message) => filter?.messageRunIds?.includes(message.runId) ?? true)
                  .map((message) => ({ ...message, role: "assistant" })),
                runtimeRequests: world.requests,
                subagents: world.subagents,
                providerThreads: world.providerThreads,
                runs: world.runs,
                turnItems: world.turnItems,
              } as never;
            }),
          dispatch: (command) => dispatchIn(world, command),
        }),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          callHostTool: (call, authorize) =>
            authorize.pipe(
              Effect.flatMap((ceiling) =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((at) => {
                    if (
                      [
                        "goat_thread_checkpoint_capture",
                        "goat_thread_checkpoint_restore",
                        "goat_thread_checkpoint_reconcile",
                        "goat_thread_interrupt",
                      ].includes(call.tool)
                    ) {
                      expect(call.existingSessionOnly).toBe(true);
                      expect(call.requireReady).toBe(true);
                    }
                    world.hostCalls.push({ call, ceiling, at });
                    return world.hostCall(call);
                  }),
                ),
              ),
            ),
        }),
        Layer.mock(CompletionWebhook.CompletionWebhook)({
          notify: (watch, report) =>
            Effect.suspend(() => {
              world.webhookReports.push({ watch, report });
              return world.webhookNotify ?? Effect.void;
            }),
          watchesExternal: () => Effect.sync(() => world.webhookWatchesExternal),
          wants: () => Queue.offer(world.wantsAsked, undefined).pipe(Effect.as(world.webhookWants)),
          release: (target) =>
            Effect.suspend(() => {
              world.releasedTargets.push(target);
              return world.webhookRelease ?? Effect.void;
            }),
        }),
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        NodeCrypto.layer,
        Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return {
              ...fs,
              rename: (from: string, to: string) =>
                fs
                  .rename(from, to)
                  .pipe(
                    Effect.andThen(
                      to.includes("watch-replicas/")
                        ? (world.payloadStaged ?? Effect.void)
                        : Effect.void,
                    ),
                  ),
            };
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );

/** Runs body against a fresh service over baseDir; leaving it stops the service like a shutdown. */
const withService = <A, E>(
  world: World,
  baseDir: string,
  body: (service: LaunchWatchService.LaunchWatchServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* LaunchWatchService.LaunchWatchService;
    return yield* body(service);
  }).pipe(Effect.provide(layerFor(world, baseDir)));

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "goat-launch-watch-" });
}).pipe(Effect.provide(NodeServices.layer));

/**
 * Advances the test clock until milestone arrives, for followers sleeping
 * through backoff or a retry pause.
 */
const advanceUntil = <A, E>(milestone: Effect.Effect<A, E>) =>
  Effect.raceFirst(
    milestone,
    Effect.forever(TestClock.adjust("10 seconds").pipe(Effect.andThen(Effect.yieldNow))),
  );

const finished = (runId: RunId, status: "completed" | "failed" = "completed"): WaitAnswer =>
  Effect.succeed({ threadId: target, run: { id: runId, status } as never, timedOut: false });

const stillRunning = (runId: RunId): WaitAnswer =>
  Effect.succeed({
    threadId: target,
    run: { id: runId, status: "running" } as never,
    timedOut: true,
  });

const local = { launcherThreadId: launcher, host: null, threadId: target } as const;

const watchLocal = (service: LaunchWatchService.LaunchWatchServiceShape, runId: RunId | null) =>
  service.register({ ...local, projectId, title: "Fix the flake", runId });

const watchRemote = (service: LaunchWatchService.LaunchWatchServiceShape, runId: RunId) =>
  service.register({
    launcherThreadId: launcher,
    host: " box ",
    threadId: target,
    projectId: null,
    title: null,
    runId,
  });

const pendingRuns = (service: LaunchWatchService.LaunchWatchServiceShape) =>
  service.list(launcher).pipe(Effect.map(([watch]) => watch?.pendingRuns ?? null));

describe("LaunchWatchService", () => {
  it.effect("wakes the launcher once when the followed run ends, with its answer and branch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.assistantMessages.push(
        { runId: run1, text: "Looking into it." },
        { runId: run1, text: "Fixed the flake; tests pass." },
      );
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          const wake = yield* Queue.take(world.delivered);
          expect(wake).toMatchObject({
            threadId: launcher,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            notification: { source: { kind: "background_task" }, outcome: "completed" },
          });
          expect(wake.text).toContain("finished run run-1 with status completed");
          expect(wake.text).toContain("branch goat/fix");
          expect(wake.text).toContain("Fixed the flake; tests pass.");
          expect(wake.text).not.toContain("Looking into it.");
          expect(world.waitCalls[0]).toMatchObject({ projectId, threadId: target, runId: run1 });
        }),
      );
      // A restarted service has nothing left to follow for that run.
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const [watch] = yield* service.list(launcher);
          expect(watch?.pendingRuns).toEqual([]);
          expect(watch?.reportedRuns).toEqual([run1]);
        }),
      );
      expect(world.deliveredLog).toHaveLength(1);
      expect(world.waitCalls).toHaveLength(1);
    }),
  );

  it.effect("reports the run a promoted send joined, under that run, once", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.assistantMessages.push({ runId: run1, text: "Joined and finished." });
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          // run-2 was a queued send promoted into the running run-1; the wait follows it there.
          yield* watchLocal(service, run2);
          yield* Queue.offer(world.waits, finished(run1));
          const wake = yield* Queue.take(world.delivered);
          expect(wake.text).toContain("finished run run-1 with status completed");
          expect(wake.text).toContain("Joined and finished.");
          const [watch] = yield* service.list(launcher);
          expect(watch?.pendingRuns).toEqual([]);
          expect(watch?.reportedRuns).toEqual([run2, run1]);

          // When the joined run was watched and reported already, the promoted send adds nothing.
          yield* service.rearm({ ...local, runId: RunId.make("run-3") });
          yield* service.rearm({ ...local, runId: RunId.make("run-4") });
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(RunId.make("run-4")));
          const next = yield* Queue.take(world.delivered);
          expect(next.text).toContain("finished run run-4");
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      expect(world.deliveredLog).toHaveLength(2);
      expect(world.webhookReports.map(({ report }) => report.runId)).toEqual([run1, "run-4"]);
    }),
  );

  it.effect("reports queued runs in order, each once, including one added as the last ends", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          // Resending to a run already followed changes nothing.
          yield* service.rearm({ ...local, runId: run1 });
          yield* Queue.offer(world.waits, finished(run1));
          const first = yield* Queue.take(world.delivered);
          expect(first.text).toContain("finished run run-1 with status completed");
          // The follower may be exiting right now; the next send must still be followed.
          yield* service.rearm({ ...local, runId: run2 });
          yield* Queue.offer(world.waits, finished(run2, "failed"));
          const second = yield* Queue.take(world.delivered);
          expect(second.text).toContain("finished run run-2 with status failed");
          expect(second.notification?.outcome).toBe("failed");
          expect(world.waitCalls.map((call) => call.runId)).toEqual([run1, run2]);
          // A reported run is not followed again.
          yield* service.rearm({ ...local, runId: run2 });
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      expect(world.waitCalls).toHaveLength(2);
      expect(world.deliveredLog).toHaveLength(2);
    }),
  );

  it.effect("resumes a pending run after a restart without a wake from the shutdown", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
        }),
      );
      // Stopping the server mid-wait reports nothing and leaves the run owed.
      expect(world.deliveredLog).toEqual([]);
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          expect(yield* pendingRuns(service)).toEqual([run1]);
          yield* Queue.offer(world.waits, finished(run1));
          const wake = yield* Queue.take(world.delivered);
          expect(wake.commandId).toContain("run:run-1");
        }),
      );
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );

  it.effect("reports each pending question once while the run keeps going", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
          yield* Queue.offer(world.waits, stillRunning(run1));
          const first = yield* Queue.take(world.delivered);
          expect(first.text).toContain("waiting on a user input request (question-1)");
          expect(first.text).toContain("pending_request.read");
          expect(first.notification?.outcome).toBe("updated");

          // The same question at the next tick is not news; an approval is, and it says
          // where it can be given.
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, stillRunning(run1));
          yield* Queue.take(world.waitStarted);
          world.requests = [
            { id: "question-1", status: "pending", kind: "user_input" },
            { id: "approval-1", status: "pending", kind: "command" },
            { id: "tool-call", status: "pending", kind: "dynamic_tool_call" },
          ];
          yield* Queue.offer(world.waits, stillRunning(run1));
          const second = yield* Queue.take(world.delivered);
          expect(second.text).toContain("approval-1");
          expect(second.text).not.toContain("goat_pending_request_respond");

          world.requests = [];
          yield* Queue.offer(world.waits, finished(run1));
          const last = yield* Queue.take(world.delivered);
          expect(last.text).toContain("finished run run-1");
        }),
      );
      expect(world.deliveredLog).toHaveLength(3);
    }),
  );

  it.effect.each(["local", "remote"] as const)(
    "a reported unanswered question waits for the tick, while a new question releases immediately ($0)",
    (mode) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        const started = yield* Queue.unbounded<void>();
        const changes = yield* Queue.unbounded<void>();
        const firstLongWait = yield* Deferred.make<void>();
        let calls = 0;
        const inputs: Array<{ ignoreRequestIds?: ReadonlyArray<string>; timeoutMs: number }> = [];
        world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
        const wait = (input: { ignoreRequestIds?: ReadonlyArray<string>; timeoutMs: number }) =>
          Effect.gen(function* () {
            calls++;
            inputs.push(input);
            yield* Queue.offer(started, undefined);
            const novel = world.requests.filter((q) => !input.ignoreRequestIds?.includes(q.id));
            let timedOut = false;
            // Bound a broken follower too: only the first wait can return without a gate.
            if (novel.length === 0 || calls > 1) {
              yield* Deferred.succeed(firstLongWait, undefined);
              timedOut = yield* Queue.take(changes).pipe(
                Effect.as(false),
                Effect.timeoutOrElse({
                  duration: input.timeoutMs,
                  orElse: () => Effect.succeed(true),
                }),
              );
            }
            return {
              threadId: target,
              run: { id: run1, status: "waiting" } as never,
              timedOut,
            };
          });
        if (mode === "local") world.waitHandler = wait;
        else
          world.hostCall = (call) =>
            call.tool === "goat_thread_wait"
              ? wait(call.arguments as { timeoutMs: number }).pipe(
                  Effect.map((result) => ({
                    threadId: target,
                    runId: run1,
                    status: "waiting",
                    timedOut: result.timedOut,
                  })),
                )
              : Effect.succeed({ requestIds: world.requests.map((q) => q.id) });
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* mode === "local" ? watchLocal(service, run1) : watchRemote(service, run1);
            yield* Queue.take(started);
            expect((yield* Queue.take(world.delivered)).text).toContain("question-1");
            yield* Queue.take(started);
            yield* Deferred.await(firstLongWait);
            expect(inputs[1]?.ignoreRequestIds).toEqual(["question-1"]);
            const tick = mode === "local" ? 30_000 : 120_000;
            yield* TestClock.adjust(tick - 1);
            expect(calls).toBe(2);
            const before = yield* Clock.currentTimeMillis;
            world.requests.push({ id: "question-2", status: "pending", kind: "user_input" });
            yield* Queue.offer(changes, undefined);
            expect((yield* Queue.take(world.delivered)).text).toContain("question-2");
            yield* Queue.take(started);
            expect(yield* Clock.currentTimeMillis).toBe(before);
            expect(inputs[2]?.ignoreRequestIds).toEqual(["question-1", "question-2"]);
            yield* TestClock.adjust(tick - 1);
            expect(calls).toBe(3);
            yield* TestClock.adjust(1);
            yield* Queue.take(started);
            expect(calls).toBe(4);
            expect(world.deliveredLog).toHaveLength(2);
          }),
        );
      }),
  );

  it.effect("a strict legacy wait refusal retries once and stays incapable for this follower", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const starts = yield* Queue.unbounded<void>();
      const nextTick = yield* Deferred.make<void>();
      let waits = 0;
      world.hostCall = (call) =>
        call.tool !== "goat_thread_wait"
          ? Effect.succeed({ requestIds: ["question-1"] })
          : Effect.gen(function* () {
              waits++;
              yield* Queue.offer(starts, undefined);
              if (call.arguments.ignoreRequestIds !== undefined)
                return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "remote_refused",
                  remoteCode: "invalid_request",
                  message: "goat_thread_wait does not take ignoreRequestIds, so nothing ran",
                });
              if (waits === 3) yield* Deferred.await(nextTick);
              if (waits > 3) return yield* Effect.never;
              return { threadId: target, runId: run1, status: "waiting", timedOut: true };
            });
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          yield* Queue.take(starts);
          yield* Queue.take(world.delivered);
          yield* Queue.take(starts);
          yield* Queue.take(starts);
          yield* Deferred.succeed(nextTick, undefined);
          yield* Queue.take(starts);
          expect(
            world.hostCalls
              .filter(({ call }) => call.tool === "goat_thread_wait")
              .map(({ call }) => call.arguments.ignoreRequestIds),
          ).toEqual([undefined, ["question-1"], undefined, undefined]);
          expect(world.deliveredLog).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect.each(["failure", "empty", "reported"] as const)(
    "backs off after an early remote release with no new listed question ($0)",
    (listing) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        const paused = yield* Deferred.make<void>();
        const restarted = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        let waits = 0;
        world.hostCall = (call) => {
          if (call.tool === "goat_thread_wait")
            return Effect.gen(function* () {
              waits++;
              if (waits > (listing === "reported" ? 2 : 1)) {
                yield* Deferred.succeed(restarted, undefined);
                return yield* Effect.never;
              }
              return { threadId: target, runId: run1, status: "waiting", timedOut: false };
            });
          return listing === "failure"
            ? Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "ssh_failed",
                  message: "list failed",
                }),
              )
            : Effect.succeed({ requestIds: listing === "reported" ? ["question-1"] : [] });
        };
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* watchRemote(service, run1);
            if (listing === "reported") yield* Queue.take(world.delivered);
            const milestone = yield* Effect.raceFirst(
              Deferred.await(paused).pipe(Effect.as("paused")),
              Deferred.await(restarted).pipe(Effect.as("restarted")),
            );
            expect(milestone).toBe("paused");
            expect(waits).toBe(listing === "reported" ? 2 : 1);
            yield* TestClock.adjust(30_000);
            yield* Deferred.await(restarted);
          }),
        ).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              (Duration.toMillis(duration) === 30_000
                ? Deferred.succeed(paused, undefined)
                : Effect.void
              ).pipe(Effect.andThen(clock.sleep(duration))),
          }),
        );
      }),
  );

  it.effect.each(["failure", "empty", "other"] as const)(
    "merges early remote wait question ids with the list ($0)",
    (listing) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        const restarted = yield* Deferred.make<void>();
        let waits = 0;
        world.hostCall = (call) => {
          if (call.tool === "goat_thread_wait")
            return Effect.gen(function* () {
              if (++waits > 1) {
                yield* Deferred.succeed(restarted, undefined);
                return yield* Effect.never;
              }
              return {
                threadId: target,
                runId: run1,
                status: "waiting",
                timedOut: false,
                pendingRequestIds: ["question-1"],
              };
            });
          return listing === "failure"
            ? Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "ssh_failed",
                  message: "list failed",
                }),
              )
            : Effect.succeed({ requestIds: listing === "other" ? ["question-2"] : [] });
        };
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* watchRemote(service, run1);
            yield* Deferred.await(restarted);
            const [watch] = yield* service.list(launcher);
            expect(watch?.reportedQuestions.toSorted()).toEqual(
              listing === "other" ? ["run-1/question-1", "run-1/question-2"] : ["run-1/question-1"],
            );
            expect(world.deliveredLog).toHaveLength(listing === "other" ? 2 : 1);
            expect(
              world.hostCalls.filter(({ call }) => call.tool === "goat_thread_wait")[1]?.call
                .arguments.ignoreRequestIds,
            ).toEqual(listing === "other" ? ["question-2", "question-1"] : ["question-1"]);
          }),
        );
      }),
  );

  it.effect.each([
    {
      reason: "remote_refused" as const,
      message: "goat_thread_wait does not take ignoreRequestIds",
    },
    {
      reason: "remote_refused" as const,
      message: "goat_thread_wait does not take otherField, so nothing ran",
    },
    {
      reason: "ssh_failed" as const,
      message: "goat_thread_wait does not take ignoreRequestIds, so nothing ran",
    },
  ])("only the strict wait refusal disables exclusions: $reason $message", ({ reason, message }) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const paused = yield* Deferred.make<void>();
      const restarted = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      let waits = 0;
      world.hostCall = (call) =>
        call.tool === "goat_thread_wait"
          ? Effect.gen(function* () {
              waits++;
              if (waits === 2)
                return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                  reason,
                  remoteCode: "invalid_request",
                  message,
                });
              if (waits > 2) {
                yield* Deferred.succeed(restarted, undefined);
                return yield* Effect.never;
              }
              return { threadId: target, runId: run1, status: "waiting", timedOut: false };
            })
          : Effect.succeed({ requestIds: ["question-1"] });
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          yield* Queue.take(world.delivered);
          yield* Deferred.await(paused);
          expect(waits).toBe(2);
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(restarted);
          expect(
            world.hostCalls
              .filter(({ call }) => call.tool === "goat_thread_wait")
              .map(({ call }) => call.arguments.ignoreRequestIds),
          ).toEqual([undefined, ["question-1"], ["question-1"]]);
        }),
      ).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            (Duration.toMillis(duration) === 30_000
              ? Deferred.succeed(paused, undefined)
              : Effect.void
            ).pipe(Effect.andThen(clock.sleep(duration))),
        }),
      );
    }),
  );

  it.effect.each(
    (["launcher", "legacy", "provider-native", "foreign", "other-launcher"] as const).flatMap(
      (ownership) => [true, false].map((escalationExists) => ({ ownership, escalationExists })),
    ),
  )(
    "local watch gives owned escalations time to arrive ($ownership, stored=$escalationExists)",
    ({ ownership, escalationExists }) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        const paused = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        const shell = world.shells.get(target)!;
        if (escalationExists) world.escalationMessages.add("question-escalation:target:question-1");
        if (ownership === "legacy" || ownership === "provider-native") {
          world.shells.set(target, {
            ...shell,
            lineage: {
              parentThreadId: launcher,
              relationshipToParent: "subagent",
              rootThreadId: launcher,
            },
            creationSource: ownership === "legacy" ? "mcp" : "provider",
          });
          world.subagents.push({ origin: "app_owned", childThreadId: target });
        } else
          world.shells.set(target, {
            ...shell,
            launchedBy: {
              kind: "launch" as const,
              environmentLabel: null,
              threadTitle: null,
              threadId: ownership === "other-launcher" ? ThreadId.make("other") : launcher,
              environmentId: ownership === "foreign" ? EnvironmentId.make("foreign") : null,
              via: "thread_launch",
            },
          });
        world.requests = [
          { id: "question-1", status: "pending", kind: "user_input" },
          { id: "approval-1", status: "pending", kind: "command" },
        ];
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* watchLocal(service, run1);
            yield* Queue.take(world.waitStarted);
            yield* Queue.offer(world.waits, stillRunning(run1));
            const owned = ownership === "launcher" || ownership === "legacy";
            if (owned && !escalationExists) {
              const milestone = yield* Effect.raceFirst(
                Deferred.await(paused).pipe(Effect.as("paused")),
                Queue.take(world.waitStarted).pipe(Effect.as("continued")),
              );
              expect(milestone).toBe("paused");
              const [before] = yield* service.list(launcher);
              expect(before?.reportedQuestions).toEqual(["run-1/approval-1"]);
              expect(world.deliveredLog).toHaveLength(1);
              expect(world.deliveredLog[0]?.text).toContain("approval-1");
              yield* TestClock.adjust(29_999);
              expect(world.deliveredLog).toHaveLength(1);
              expect(world.waitCalls).toHaveLength(1);
              yield* TestClock.adjust(1);
              yield* Queue.take(world.waitStarted);
              yield* Queue.offer(world.waits, stillRunning(run1));
            }
            // The next wait starts only after wakes and reported keys have been saved.
            yield* Queue.take(world.waitStarted);
            const [watch] = yield* service.list(launcher);
            expect(watch?.reportedQuestions.toSorted()).toEqual([
              "run-1/approval-1",
              "run-1/question-1",
            ]);
            expect(world.deliveredLog).toHaveLength(owned && escalationExists ? 1 : 2);
            expect(world.escalationReads).toEqual(
              owned
                ? Array.from({ length: escalationExists ? 1 : 2 }, () => [
                    "question-escalation:target:question-1",
                  ])
                : [],
            );
            expect(world.deliveredLog.some((message) => message.text.includes("approval-1"))).toBe(
              true,
            );
            yield* service.rearm({ ...local, runId: run2 });
            world.requests = [];
            yield* Queue.offer(world.waits, finished(run1));
            yield* Queue.take(world.waitStarted);
            expect(world.waitCalls.at(-1)?.ignoreRequestIds).toEqual([]);
          }),
        ).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              (Duration.toMillis(duration) === 30_000
                ? Deferred.succeed(paused, undefined)
                : Effect.void
              ).pipe(Effect.andThen(clock.sleep(duration))),
          }),
        );
      }),
  );

  it.effect.each([true, false])(
    "keeps a question unreported until an escalation or watch notice exists (escalated=$0)",
    (escalated) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        const pauses = yield* Queue.unbounded<void>();
        const clock = yield* Clock.Clock;
        world.shells.set(target, {
          ...world.shells.get(target),
          launchedBy: {
            kind: "launch" as const,
            environmentLabel: null,
            threadTitle: null,
            threadId: launcher,
            environmentId: null,
            via: "thread_launch",
          },
        });
        world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
        world.dispatchFailures.push("transient");
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* watchLocal(service, run1);
            yield* Queue.take(world.waitStarted);
            yield* Queue.offer(world.waits, stillRunning(run1));
            yield* Queue.take(pauses);
            const [before] = yield* service.list(launcher);
            expect(before?.reportedQuestions).toEqual([]);
            expect(world.deliveredLog).toEqual([]);
            expect(world.attempts).toEqual([]);
            yield* TestClock.adjust(29_999);
            expect(world.attempts).toEqual([]);
            if (escalated) world.escalationMessages.add("question-escalation:target:question-1");
            yield* TestClock.adjust(1);
            yield* Queue.take(world.waitStarted);
            yield* Queue.offer(world.waits, stillRunning(run1));
            if (!escalated) {
              yield* Queue.take(pauses);
              const [retrying] = yield* service.list(launcher);
              expect(retrying?.reportedQuestions).toEqual([]);
              expect(world.deliveredLog).toEqual([]);
              expect(world.attempts).toHaveLength(1);
              yield* TestClock.adjust(30_000);
              yield* Queue.take(world.waitStarted);
              yield* Queue.offer(world.waits, stillRunning(run1));
            }
            yield* Queue.take(world.waitStarted);
            const [after] = yield* service.list(launcher);
            expect(after?.reportedQuestions).toEqual(["run-1/question-1"]);
            expect(world.deliveredLog).toHaveLength(escalated ? 0 : 1);
            expect(world.attempts).toHaveLength(escalated ? 0 : 2);
          }),
        ).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              (Duration.toMillis(duration) === 30_000
                ? Queue.offer(pauses, undefined)
                : Effect.void
              ).pipe(Effect.andThen(clock.sleep(duration))),
          }),
        );
      }),
  );

  it.effect("starts a new escalation grace period when a question disappears and returns", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const pauses = yield* Queue.unbounded<void>();
      const clock = yield* Clock.Clock;
      world.shells.set(target, {
        ...world.shells.get(target),
        launchedBy: {
          kind: "launch" as const,
          environmentLabel: null,
          threadTitle: null,
          threadId: launcher,
          environmentId: null,
          via: "thread_launch",
        },
      });
      const question = { id: "question-1", status: "pending", kind: "user_input" };
      world.requests = [question];
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, stillRunning(run1));
          yield* Queue.take(pauses);
          yield* TestClock.adjust(30_000);
          yield* Queue.take(world.waitStarted);
          world.requests = [];
          yield* Queue.offer(world.waits, stillRunning(run1));
          yield* Queue.take(world.waitStarted);
          world.requests = [question];
          yield* Queue.offer(world.waits, stillRunning(run1));
          const milestone = yield* Effect.raceFirst(
            Queue.take(pauses).pipe(Effect.as("paused")),
            Queue.take(world.waitStarted).pipe(Effect.as("continued")),
          );
          expect(milestone).toBe("paused");
          expect(world.attempts).toEqual([]);
          const [before] = yield* service.list(launcher);
          expect(before?.reportedQuestions).toEqual([]);
          world.escalationMessages.add("question-escalation:target:question-1");
          yield* TestClock.adjust(30_000);
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, stillRunning(run1));
          yield* Queue.take(world.waitStarted);
          const [after] = yield* service.list(launcher);
          expect(after?.reportedQuestions).toEqual(["run-1/question-1"]);
          expect(world.deliveredLog).toEqual([]);
        }),
      ).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            (Duration.toMillis(duration) === 30_000
              ? Queue.offer(pauses, undefined)
              : Effect.void
            ).pipe(Effect.andThen(clock.sleep(duration))),
        }),
      );
    }),
  );

  it.effect("tells the launcher once when a host stays unreachable, then reports the run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      let failures = 4;
      const readArgs: Array<Record<string, unknown>> = [];
      world.hostCall = (call) => {
        switch (call.tool) {
          case "goat_thread_wait":
            if (failures > 0) {
              failures -= 1;
              // The launcher's mode drops during the outage; later calls carry the new ceiling.
              if (failures === 1) {
                world.shells.set(launcher, {
                  ...world.shells.get(launcher),
                  runtimeMode: "approval-required",
                });
              }
              return Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "box is unavailable: connection refused",
                }),
              );
            }
            return Effect.succeed({
              threadId: target,
              runId: run1,
              status: "completed",
              timedOut: false,
            });
          case "goat_thread_read":
            readArgs.push(call.arguments);
            if (call.arguments.limit === 1) return Effect.succeed(remoteRead({ itemCount: 100 }));
            return Effect.succeed(
              call.arguments.afterPosition === 59
                ? remoteRead({
                    itemCount: 100,
                    items: [
                      remoteItem(70, run1, "First pass done."),
                      remoteItem(79, run2, "An answer from another run."),
                    ],
                    nextPosition: 79,
                  })
                : remoteRead({
                    itemCount: 100,
                    items: [remoteItem(95, run1, "Remote fix pushed.")],
                  }),
            );
          default:
            return Effect.die(new Error("unexpected " + call.tool));
        }
      };
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          const outage = yield* advanceUntil(Queue.take(world.delivered));
          const done = yield* advanceUntil(Queue.take(world.delivered));
          expect(outage.text).toMatch(/^host_unavailable: GOAT cannot reach host box/);
          expect(outage.notification?.outcome).toBe("unknown");
          expect(done.text).toContain("(threadId target, host box) finished run run-1");
          expect(done.text).toContain("Remote fix pushed.");
          expect(done.text).not.toContain("another run");
          // The wake and its state are saved under the lock list waits for.
          const [watch] = yield* service.list(launcher);
          expect(watch?.outage).toBeNull();
        }),
      );
      // Reads only, at the launcher's runtime mode as it is at each call.
      expect(
        world.hostCalls.every(({ call }) => call.writes === false && call.host === "box"),
      ).toBe(true);
      expect(world.hostCalls[0]?.ceiling).toBe("full-access");
      expect(world.hostCalls.at(-1)?.ceiling).toBe("approval-required");
      // The transcript tail starts a fixed window before its end and follows its pages.
      expect(readArgs.map((args) => args.afterPosition)).toEqual([undefined, 59, 79]);
    }),
  );

  it.effect("tells the launcher why a run failed preparing its workspace, with the log", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      world.runs.push({
        id: run1,
        status: "failed",
        workspacePreparation: { type: "worktree", baseRef: "dev" },
      });
      world.turnItems.push({
        type: "error",
        status: "failed",
        runId: run1,
        ordinal: 2,
        failure: {
          class: "unknown",
          code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
          retryable: true,
          message:
            "Workspace preparation failed during provision worktree: Git made no progress for 2m 0s. It had already stalled once and was retried.",
          log: "Fetching dev from its remote.\nReceiving objects:  45% (900/2000)",
        },
      });
      yield* Queue.offer(world.waits, finished(run1, "failed"));
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          const wake = yield* Queue.take(world.delivered);
          expect(wake.text).toContain(
            'Launched thread "Fix the flake" (threadId target, this environment) failed while GOAT prepared its workspace, in run run-1 (error class unknown, retryable).',
          );
          expect(wake.text).toContain("It had already stalled once and was retried.");
          expect(wake.text).toContain(
            "Preparation log (last lines, redacted):\nFetching dev from its remote.\nReceiving objects:  45% (900/2000)",
          );
          expect(wake.text).toContain("Suggested action: Git on this machine was slow or stuck");
          expect(wake.text).toContain('"thread.retry", args: {threadId: "target"}}');
          expect(wake.notification).toMatchObject({
            outcome: "failed",
            summary: 'Launched thread "Fix the flake" failed preparing its workspace',
          });
          expect(wake.notification?.detail).toContain("Receiving objects:  45%");
        }),
      );
    }),
  );

  it.effect.each([
    {
      host: "an older host",
      status: {
        lastError:
          "Workspace preparation failed during provision worktree: Git command failed in GitVcsDriver.fetchRemote (/repo): Git command timed out.",
        lastErrorClass: "validation_error",
      },
      retry: "Retry it from a GOAT client connected to box",
    },
    {
      host: "an updated host",
      status: {
        lastError: "Workspace preparation failed during provision worktree: timed out.",
        lastErrorClass: "unknown",
        failure: {
          runId: run1,
          stage: "workspace_preparation",
          errorClass: "unknown",
          retryable: true,
          message: "Workspace preparation failed during provision worktree: timed out.",
          log: "Fetching dev from its remote.",
          canRetry: true,
        },
      },
      retry: 'Retry with goat_call {path: "thread.retry", args: {threadId: "target", host: "box"}}',
    },
  ])("reports a remote run that failed preparing its workspace, from $host", (example) =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      world.hostCall = (call) => {
        switch (call.tool) {
          case "goat_thread_wait":
            return Effect.succeed({
              threadId: target,
              runId: run1,
              status: "failed",
              timedOut: false,
            });
          case "goat_thread_read":
            return Effect.succeed(remoteRead({ itemCount: 1 }));
          case "goat_thread_status":
            return Effect.succeed({
              threadId: target,
              title: "Remote fix",
              phase: "failed",
              terminal: true,
              run: { runId: run1, status: "failed" },
              ...example.status,
            });
          default:
            return Effect.die(new Error("unexpected " + call.tool));
        }
      };
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          const wake = yield* Queue.take(world.delivered);
          expect(wake.text).toContain(
            "(threadId target, host box) failed while GOAT prepared its workspace, in run run-1",
          );
          expect(wake.text).toContain(example.status.lastError);
          expect(wake.text).toContain("Suggested action: Git on box was slow or stuck");
          expect(wake.text).toContain(example.retry);
          expect(wake.notification?.outcome).toBe("failed");
        }),
      );
      expect(world.hostCalls.every(({ call }) => call.writes === false)).toBe(true);
    }),
  );

  it.effect("reads a short remote transcript from its start", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const readArgs: Array<Record<string, unknown>> = [];
      world.hostCall = (call) => {
        if (call.tool === "goat_thread_wait") {
          return Effect.succeed({
            threadId: target,
            runId: run1,
            status: "completed",
            timedOut: false,
          });
        }
        readArgs.push(call.arguments);
        return Effect.succeed(
          remoteRead({ itemCount: 6, items: [remoteItem(5, run1, "Short answer.")] }),
        );
      };
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          const wake = yield* Queue.take(world.delivered);
          expect(wake.text).toContain("Short answer.");
        }),
      );
      expect(readArgs[1]).not.toHaveProperty("afterPosition");
    }),
  );

  it.effect("keeps backing off after a restart in an outage, without a second notice", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      let reachable = false;
      let retryDueAt = 0;
      world.hostCall = (call) => {
        if (!reachable) {
          return Effect.fail(
            new SshRemoteDispatch.SshRemoteDispatchError({
              reason: "ssh_failed",
              message: "SSH to box failed",
            }),
          );
        }
        return call.tool === "goat_thread_wait"
          ? Effect.succeed({ threadId: target, runId: run1, status: "completed", timedOut: false })
          : Effect.succeed(remoteRead({ itemCount: 0 }));
      };
      retryDueAt = yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          yield* advanceUntil(Queue.take(world.delivered));
          const [watch] = yield* service.list(launcher);
          expect(watch?.outage?.notified).toBe(true);
          return watch?.outage?.nextRetryAt ?? 0;
        }),
      );
      const contactsBefore = world.hostCalls.length;
      reachable = true;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* advanceUntil(Queue.take(world.delivered));
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      // The restarted follower kept the persisted backoff instead of calling at once.
      expect(world.hostCalls[contactsBefore]?.at).toBeGreaterThanOrEqual(retryDueAt);
      expect(world.deliveredLog[0]?.text).toMatch(/^host_unavailable/);
      expect(world.deliveredLog[1]?.text).toContain("finished run run-1");
    }),
  );

  it.effect("stops an unwatched follower, and a new watch reports its own run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          expect(yield* service.unwatch(local)).toBe(true);
          expect(yield* service.unwatch(local)).toBe(false);
          yield* watchLocal(service, run2);
          expect(yield* Queue.take(world.waitStarted)).toBe(run2);
          yield* Queue.offer(world.waits, finished(run2));
          const wake = yield* Queue.take(world.delivered);
          expect(wake.commandId).toContain("run:run-2");
        }),
      );
      expect(world.deliveredLog).toHaveLength(1);
    }),
  );

  it.effect("lists the newest remote watches across launchers, up to the limit", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const listed = yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const remote = (host: string, threadId: string) =>
            service.register({
              launcherThreadId: launcher,
              host,
              threadId: ThreadId.make(threadId),
              projectId: null,
              title: threadId,
              runId: null,
            });
          yield* remote("box", "oldest");
          yield* TestClock.adjust("1 second");
          yield* remote("gpu", "middle");
          yield* TestClock.adjust("1 second");
          yield* remote("box", "newest");
          yield* TestClock.adjust("1 second");
          yield* watchLocal(service, null);
          return yield* service.listRemote(2);
        }),
      );
      expect(listed.map((watch) => [watch.host, watch.threadId])).toEqual([
        ["box", "newest"],
        ["gpu", "middle"],
      ]);
    }),
  );

  it.effect("drops the watch without a wake when the launcher is archived while it waits", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          // The follower read the launcher once before it started waiting.
          yield* Queue.take(world.launcherReads);
          world.shells.set(launcher, {
            ...world.shells.get(launcher),
            archivedAt: DateTime.makeUnsafe(0) as never,
          });
          yield* Queue.offer(world.waits, finished(run1));
          // It reads the launcher again under the lock before it would wake it; list waits
          // for that lock.
          yield* Queue.take(world.launcherReads);
          expect(yield* service.list(launcher)).toEqual([]);
        }),
      );
      expect(world.attempts).toEqual([]);
    }),
  );

  it.effect("retries a wake the orchestrator failed to store under a fresh id, once", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      world.dispatchFailures.push("transient");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(run1));
          const delivered = yield* advanceUntil(Queue.take(world.delivered));
          const [first] = world.attempts;
          expect(delivered.commandId).toBe(first?.commandId + ":attempt-1");
          expect(delivered.messageId).toBe(first?.messageId + ":attempt-1");
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      expect(world.attempts).toHaveLength(2);
    }),
  );

  it.effect("hands a run report to the completion webhook once its wake is queued", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.shells.set(target, {
        ...world.shells.get(target),
        linkedPullRequest: { url: "https://github.com/acme/app/pull/7" } as never,
      });
      world.assistantMessages.push({ runId: run1, text: "Fixed the flake; tests pass." });
      world.dispatchFailures.push("transient");
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...local,
            projectId,
            title: null,
            runId: run1,
            notifyWebhook: true,
          });
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(run1));
          yield* advanceUntil(Queue.take(world.delivered));
          // list waits for the lock the wake and its report run under.
          yield* service.list(launcher);
        }),
      );
      // The failed first wake reported nothing; the queued retry reported once, under the
      // event's stable id rather than the retry's.
      expect(world.webhookReports).toHaveLength(1);
      const [{ watch, report }] = world.webhookReports as [(typeof world.webhookReports)[number]];
      expect(watch.notifyWebhook).toBe(true);
      expect(report).toEqual({
        id: world.attempts[0]?.commandId,
        event: "run.completed",
        runId: run1,
        status: "completed",
        title: "Fix the flake",
        summary: 'Launched thread "Fix the flake" completed',
        excerpt: "Fixed the flake; tests pass.",
        prUrl: "https://github.com/acme/app/pull/7",
      });
    }),
  );

  it.effect("wakes the launcher but posts no run.completed for a link-only registered run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.providerThreads = [{ cloudTask: { attach: "registered", tracking: "link-only" } }];
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...local,
            projectId,
            title: null,
            runId: run1,
            notifyWebhook: true,
          });
          yield* Queue.offer(world.waits, finished(run1));
          yield* advanceUntil(Queue.take(world.delivered));
          yield* service.list(launcher);
        }),
      );
      expect(world.attempts).toHaveLength(1);
      expect(world.webhookReports).toEqual([]);
    }),
  );

  it.effect("hands question and outage reports to the completion webhook", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
          yield* Queue.offer(world.waits, stillRunning(run1));
          yield* Queue.take(world.delivered);
          yield* service.list(launcher);
        }),
      );
      expect(world.webhookReports.map(({ report }) => report)).toEqual([
        expect.objectContaining({
          event: "question",
          runId: run1,
          requestId: "question-1",
          status: "waiting",
          excerpt: null,
          prUrl: null,
        }),
      ]);

      const remote = yield* makeWorld;
      remote.hostCall = () =>
        Effect.fail(
          new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "box is unavailable: connection refused",
          }),
        );
      yield* withService(remote, yield* tempDir, (service) =>
        Effect.gen(function* () {
          yield* watchRemote(service, run1);
          yield* advanceUntil(Queue.take(remote.delivered));
          yield* service.list(launcher);
        }),
      );
      expect(remote.webhookReports.map(({ watch, report }) => [watch.host, report])).toEqual([
        [
          "box",
          expect.objectContaining({
            event: "host.unavailable",
            runId: run1,
            status: "unreachable",
          }),
        ],
      ]);
    }),
  );

  it.effect("keeps a watch's webhook choice across restarts and re-registration", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        service.register({ ...local, projectId, title: null, runId: null, notifyWebhook: true }),
      );
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          // goat_thread_watch passes no choice and leaves it as it was.
          const watch = yield* watchLocal(service, null);
          expect(watch.notifyWebhook).toBe(true);
          const other = yield* service.register({
            launcherThreadId: launcher,
            host: null,
            threadId: ThreadId.make("other"),
            projectId,
            title: null,
            runId: null,
          });
          expect(other.notifyWebhook).toBe(false);
        }),
      );
    }),
  );

  it.effect("keeps a launch's webhook target across restarts and releases it with the watch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const inline: LaunchWatchWebhookTarget = {
        type: "inline",
        url: "https://bot.example/hook",
        secretName: "completion-webhook-watch-1",
      };
      yield* withService(world, baseDir, (service) =>
        service.register({ ...local, projectId, title: null, runId: null, webhookTarget: inline }),
      );
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          // goat_thread_watch passes no choice and leaves it as it was.
          const watch = yield* watchLocal(service, null);
          expect(watch.webhookTarget).toEqual(inline);
          expect(watch.notifyWebhook).toBe(false);
          expect(world.releasedTargets).toEqual([]);
          // Choosing another target frees the inline one's secret.
          yield* service.register({
            ...local,
            projectId,
            title: null,
            runId: null,
            webhookTarget: { type: "named", name: "bot-b" },
          });
          expect(world.releasedTargets).toEqual([inline]);
        }),
      );
      world.releasedTargets.length = 0;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...local,
            projectId,
            title: null,
            runId: null,
            webhookTarget: inline,
          });
          expect(yield* service.unwatch(local)).toBe(true);
          expect(world.releasedTargets).toEqual([inline]);
        }),
      );
    }),
  );

  it.effect("settles a wake the orchestrator refuses for good", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      world.dispatchFailures.push("refused");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.offer(world.waits, finished(run1));
          // A previously rejected id is retried once under a fresh id; that one goes through.
          yield* advanceUntil(Queue.take(world.delivered));
          expect(yield* pendingRuns(service)).toEqual([]);
        }),
      );
      expect(world.attempts).toHaveLength(2);
    }),
  );

  it.effect("keeps the gone notice owed until it can be queued", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.shells.set(target, {
        ...world.shells.get(target),
        deletedAt: DateTime.makeUnsafe(0) as never,
      });
      world.dispatchFailures.push("transient");
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          const gone = yield* advanceUntil(Queue.take(world.delivered));
          expect(gone.text).toContain("can no longer be followed: the thread was deleted.");
          expect(yield* service.list(launcher)).toEqual([]);
        }),
      );
      expect(world.waitCalls).toEqual([]);
    }),
  );

  it.effect("moves an unreadable state file aside and starts empty", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, LaunchWatchService.LAUNCH_WATCH_FILE), "{oops");
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          expect(yield* service.list(launcher)).toEqual([]);
        }),
      );
      const files = yield* fs.readDirectory(stateDir);
      expect(
        files.some((file) => file.startsWith(LaunchWatchService.LAUNCH_WATCH_FILE + ".corrupt-")),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses changes while the state file cannot be read, leaving it intact", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* withService(world, baseDir, (service) => watchLocal(service, run1));
      const file = path.join(baseDir, "userdata", LaunchWatchService.LAUNCH_WATCH_FILE);
      const before = yield* fs.readFileString(file);
      yield* fs.chmod(file, 0o000);
      const refused = yield* withService(world, baseDir, (service) =>
        Effect.result(service.register({ ...local, projectId, title: null, runId: run2 })),
      );
      yield* fs.chmod(file, 0o600);
      expect(refused._tag).toBe("Failure");
      expect(yield* fs.readFileString(file)).toBe(before);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const remoteItem = (position: number, runId: RunId, text: string) => ({
  position,
  visibility: "local",
  sourceThreadId: target,
  itemId: "item-" + position,
  runId,
  messageId: null,
  createdBy: null,
  creationSource: null,
  type: "assistant_message",
  status: "completed",
  title: null,
  text,
  textTruncated: false,
  updatedAt: "2026-10-12T00:00:00.000Z",
});

const remoteRead = (input: {
  readonly itemCount: number;
  readonly items?: ReadonlyArray<unknown>;
  readonly nextPosition?: number;
}) => ({
  thread: {
    threadId: target,
    projectId: "remote-project",
    title: "Remote fix",
    createdBy: "agent",
    creationSource: "mcp",
    status: "completed",
    latestRunId: run1,
    activeRunId: null,
    providerInstanceId: "codex",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: "goat/remote",
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 1,
    itemCount: input.itemCount,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  },
  recentRuns: [],
  items: input.items ?? [],
  nextPosition: input.nextPosition ?? null,
  hasMore: input.nextPosition !== undefined,
});

describe("LaunchWatchService launcherless watches", () => {
  const external = (
    input: {
      readonly owner?: string;
      readonly host?: string;
      readonly ceiling?: "full-access" | "auto-accept-edits";
      readonly requested?: boolean;
      readonly webhookTarget?: LaunchWatchWebhookTarget;
    } = {},
  ) => ({
    owner: input.owner ?? "client:bot-a",
    host: input.host ?? null,
    threadId: target,
    projectId: input.host === undefined ? projectId : null,
    title: "Fix the flake",
    runId: run1,
    ceiling: input.ceiling ?? ("full-access" as const),
    route: { notifyWebhook: input.requested ?? true, webhookTarget: input.webhookTarget ?? null },
  });

  const keyOf = (owner = "client:bot-a") =>
    ({ launcherThreadId: null, owner, host: null, threadId: target }) as const;

  const stateFile = (baseDir: string, file = LaunchWatchService.LAUNCHERLESS_WATCH_FILE) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return path.join(baseDir, "userdata", file);
    });

  const storedWatches = (baseDir: string, file?: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs.readFileString(yield* stateFile(baseDir, file));
      return (JSON.parse(raw) as { watches: ReadonlyArray<LaunchWatch> }).watches;
    });

  /** Makes each webhook report observable as it is handed over. */
  const reportsQueue = (world: World) =>
    Effect.gen(function* () {
      const reported = yield* Queue.unbounded<void>();
      world.webhookNotify = Queue.offer(reported, undefined).pipe(Effect.asVoid);
      return reported;
    });

  it.effect("applies the latest outside launch's webhook choice to a reused watch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const inline: LaunchWatchWebhookTarget = {
        type: "inline",
        url: "https://bot.example/hook",
        secretName: "completion-webhook-watch-1",
      };
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          const first = yield* service.watchExternal(
            external({ requested: false, webhookTarget: inline }),
          );
          expect(first).toMatchObject({ notifyWebhook: false, webhookTarget: inline });
          // A later launch of the same thread that asks for the default webhook gets it.
          const again = yield* service.watchExternal(external({ requested: true }));
          expect(again).toMatchObject({ notifyWebhook: true, webhookTarget: null });
          expect(world.releasedTargets).toEqual([inline]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records nothing for an outside launch the completion webhook does not take", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.webhookWatchesExternal = false;
      const baseDir = yield* tempDir;
      const watch = yield* withService(world, baseDir, (service) =>
        service.watchExternal(external()),
      );
      expect(watch).toBeNull();
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(yield* stateFile(baseDir))).toBe(false);
      expect(
        yield* fs.exists(yield* stateFile(baseDir, LaunchWatchService.LAUNCH_WATCH_FILE)),
      ).toBe(false);
      expect(world.waitCalls).toEqual([]);
      expect(world.webhookReports).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["the webhook stops taking it", "it outlives its retention"] as const)(
    "drops a launcherless watch when $0, while its run is still owed",
    (reason) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const baseDir = yield* tempDir;
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            yield* service.watchExternal(external());
            yield* Queue.take(world.waitStarted);
            if (reason === "the webhook stops taking it") world.webhookWants = false;
            else yield* TestClock.adjust("7 days");
            yield* Queue.offer(world.waits, stillRunning(run1));
            // Asked once before the first wait and once after it.
            yield* Queue.take(world.wantsAsked);
            yield* Queue.take(world.wantsAsked);
            // listRemote waits for the lock the drop runs under.
            yield* service.listRemote(10);
          }),
        );
        expect(yield* storedWatches(baseDir)).toEqual([]);
        expect(world.waitCalls).toHaveLength(1);
        expect(world.webhookReports).toEqual([]);
        // A restart does not bring it back.
        yield* withService(world, baseDir, (service) => service.listRemote(10));
        expect(world.waitCalls).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps launcherless watches out of the file older servers read", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      const fs = yield* FileSystem.FileSystem;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* watchLocal(service, run2);
        }),
      );
      // Older servers require a launcher on every watch in the shared file.
      expect(
        (yield* storedWatches(baseDir, LaunchWatchService.LAUNCH_WATCH_FILE)).map(
          (watch) => watch.launcherThreadId,
        ),
      ).toEqual([launcher]);
      const launcherless = yield* storedWatches(baseDir);
      expect(launcherless.map((watch) => watch.launcherThreadId)).toEqual([null]);

      // A shared file from a build that kept them together is split on load.
      const shared = yield* stateFile(baseDir, LaunchWatchService.LAUNCH_WATCH_FILE);
      yield* fs.writeFileString(
        shared,
        JSON.stringify({
          version: 1,
          watches: [
            ...launcherless,
            ...(yield* storedWatches(baseDir, LaunchWatchService.LAUNCH_WATCH_FILE)),
          ],
        }),
      );
      yield* fs.remove(yield* stateFile(baseDir));
      yield* withService(world, baseDir, (service) => service.list(launcher));
      expect(
        (yield* storedWatches(baseDir, LaunchWatchService.LAUNCH_WATCH_FILE)).map(
          (watch) => watch.launcherThreadId,
        ),
      ).toEqual([launcher]);
      expect((yield* storedWatches(baseDir)).map((watch) => watch.id)).toEqual(
        launcherless.map((watch) => watch.id),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reports an outside launch's question and run end only to the webhook, then a re-armed follow-up",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const reported = yield* reportsQueue(world);
        world.assistantMessages.push({ runId: run1, text: "Fixed the flake; tests pass." });
        const baseDir = yield* tempDir;
        yield* withService(world, baseDir, (service) =>
          Effect.gen(function* () {
            const watch = yield* service.watchExternal(external());
            expect(watch).toMatchObject({
              launcherThreadId: null,
              pendingRuns: [run1],
              notifyWebhook: true,
            });
            yield* Queue.take(world.waitStarted);
            world.requests = [{ id: "question-1", status: "pending", kind: "user_input" }];
            yield* Queue.offer(world.waits, stillRunning(run1));
            yield* Queue.take(reported);
            world.requests = [];
            yield* Queue.offer(world.waits, finished(run1));
            yield* Queue.take(reported);
            // listRemote waits for the lock the report and its state change run under.
            expect(yield* service.listRemote(10)).toEqual([]);
            // Reported, the watch stays dormant, so a follow-up send from outside re-arms it.
            expect(yield* service.find(keyOf())).toMatchObject({
              pendingRuns: [],
              reportedRuns: [run1],
            });
            yield* service.rearm({ ...keyOf(), runId: run2 });
            yield* Queue.take(world.waitStarted);
            yield* Queue.offer(world.waits, finished(run2));
            yield* Queue.take(reported);
            yield* service.listRemote(10);
          }),
        );
        expect(
          world.webhookReports.map(({ watch, report }) => [watch.launcherThreadId, report]),
        ).toEqual([
          [
            null,
            expect.objectContaining({
              event: "question",
              requestId: "question-1",
              status: "waiting",
            }),
          ],
          [
            null,
            expect.objectContaining({
              event: "run.completed",
              runId: run1,
              status: "completed",
              excerpt: "Fixed the flake; tests pass.",
            }),
          ],
          [null, expect.objectContaining({ event: "run.completed", runId: run2 })],
        ]);
        // No thread was woken or read as a launcher, and nothing is left to follow.
        expect(world.attempts).toEqual([]);
        expect(yield* Queue.size(world.launcherReads)).toBe(0);
        expect(yield* storedWatches(baseDir)).toEqual([
          expect.objectContaining({ pendingRuns: [], reportedRuns: [run1, run2] }),
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an outside caller's watch from every other outside caller", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external());
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.take(reported);
          // Another bot on the same server neither sees nor re-arms it.
          expect(yield* service.find(keyOf("client:bot-b"))).toBeNull();
          yield* service.rearm({ ...keyOf("client:bot-b"), runId: run2 });
          expect(yield* service.find(keyOf())).toMatchObject({
            owner: "client:bot-a",
            pendingRuns: [],
            reportedRuns: [run1],
          });
        }),
      );
      expect(world.waitCalls).toHaveLength(1);
      expect(world.webhookReports).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const inline: LaunchWatchWebhookTarget = {
    type: "inline",
    url: "https://bot.example/hook",
    secretName: "completion-webhook-watch-1",
  };

  it.effect("treats a dormant watch past its retention as gone when its caller sends again", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external({ webhookTarget: inline }));
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.take(reported);
          yield* TestClock.adjust("8 days");
          expect(yield* service.find(keyOf())).toBeNull();
          // A send on day 8 does not revive the webhook.
          yield* service.rearm({ ...keyOf(), runId: run2 });
          expect(yield* service.find(keyOf())).toBeNull();
        }),
      );
      expect(world.waitCalls).toHaveLength(1);
      expect(world.webhookReports).toHaveLength(1);
      expect(world.releasedTargets).toContainEqual(inline);
      expect(yield* storedWatches(baseDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drops a dormant watch past its retention while the server keeps running", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const released = yield* Queue.unbounded<void>();
      world.webhookRelease = Queue.offer(released, undefined).pipe(Effect.asVoid);
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(external({ webhookTarget: inline }));
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, finished(run1));
          yield* Queue.take(reported);
          yield* service.listRemote(10);
          expect(world.releasedTargets).toEqual([]);
          // Nothing calls the service; the periodic sweep finds it.
          yield* advanceUntil(Queue.take(released));
          yield* service.listRemote(10);
        }),
      );
      expect(world.releasedTargets).toEqual([inline]);
      expect(yield* storedWatches(baseDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows an outside launch's remote run at its caller's ceiling across a restart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const reported = yield* reportsQueue(world);
      const baseDir = yield* tempDir;
      world.hostCall = () =>
        Effect.fail(
          new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "box is unavailable: connection refused",
          }),
        );
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* service.watchExternal(
            external({ host: "box", ceiling: "auto-accept-edits", requested: false }),
          );
          yield* advanceUntil(Queue.take(reported));
        }),
      );
      expect(world.webhookReports.map(({ report }) => report.event)).toEqual(["host.unavailable"]);
      // The watch survives the restart with its outage, and resumes on first use.
      expect(yield* storedWatches(baseDir)).toEqual([
        expect.objectContaining({
          launcherThreadId: null,
          ceiling: "auto-accept-edits",
          pendingRuns: [run1],
        }),
      ]);
      world.hostCall = (call) =>
        call.tool === "goat_thread_wait"
          ? Effect.succeed({ threadId: target, runId: run1, status: "completed", timedOut: false })
          : Effect.succeed(
              remoteRead({ itemCount: 2, items: [remoteItem(1, run1, "Remote fix pushed.")] }),
            );
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          expect(yield* service.listRemote(10)).toEqual([]);
          yield* advanceUntil(Queue.take(reported));
          yield* service.listRemote(10);
        }),
      );
      expect(world.webhookReports.map(({ report }) => report.event)).toEqual([
        "host.unavailable",
        "run.completed",
      ]);
      expect(world.webhookReports[1]?.report.excerpt).toBe("Remote fix pushed.");
      // Reads only, never above what the outside caller was approved for.
      expect(world.hostCalls.length).toBeGreaterThan(3);
      expect(
        world.hostCalls.every(
          ({ call, ceiling }) => call.writes === false && ceiling === "auto-accept-edits",
        ),
      ).toBe(true);
      expect(world.attempts).toEqual([]);
      // Dormant until a later outside send re-arms it.
      expect(yield* storedWatches(baseDir)).toEqual([
        expect.objectContaining({ pendingRuns: [], reportedRuns: [run1] }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const watchReplica = (now: number): ThreadReplicaPayload => {
  const context = "Checkpoint context";
  const bytes = Buffer.from("fixture bundle");
  return {
    sourceEnvironmentId: EnvironmentId.make("box-env"),
    sourceThreadId: target,
    runId: run1,
    checkpointId: CheckpointId.make("cp-1"),
    repositoryKey: "github.com/example/recovery",
    capturedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    headOid: "a".repeat(40),
    commitOid: "b".repeat(40),
    replicaRef: "refs/goat/replicas/watch/0",
    bytes: bytes.length,
    sha256: ThreadReplicaService.replicaDigest(bytes),
    contextSha256: ThreadReplicaService.replicaDigest(context),
    contextKind: "bounded_conversation",
    context,
    bundleBase64: bytes.toString("base64"),
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  };
};
const replicaWatchInput = {
  launcherThreadId: launcher,
  host: "box",
  threadId: target,
  projectId: null,
  title: "Recover me",
  runId: run1,
} as const;
const recoveryInput = {
  ...replicaWatchInput,
  fromReplicatedCheckpoint: true,
  expectedRunId: run1,
  destinationHost: "destination",
  destinationProjectId: projectId,
} as const;
const recoveryGrant = Effect.succeed({
  runtimeMode: "full-access",
  interactionMode: "default",
} as const);

describe("ordinary watch replicas", () => {
  it.effect.each(["profiles", "pressure"] as const)(
    "blocks fresh watch recovery before reservation for %s",
    (reason) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const replica = watchReplica(yield* Clock.currentTimeMillis);
        world.hostCall = (call) =>
          Effect.succeed(
            call.tool === "goat_thread_checkpoint_capture"
              ? { status: "captured", replica }
              : call.tool === "goat_thread_checkpoint_restore"
                ? {
                    operationId: call.arguments.operationId,
                    status: "launched",
                    threadId: "replacement",
                    runId: "replacement-run",
                  }
                : call.tool === "goat_thread_wait"
                  ? { threadId: target, runId: run1, status: "completed", timedOut: false }
                  : remoteRead({ itemCount: 0 }),
          );
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
            });
            yield* Queue.take(world.delivered);
            expect((yield* service.find(replicaWatchInput))?.replica).toBeDefined();
            if (reason === "profiles")
              yield* world.settings!.updateSettings({ goatclaw: { enabled: true } });
            else world.pressureBlocked = true;
            const result = yield* service.recover(recoveryInput, recoveryGrant).pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            expect((yield* service.find(replicaWatchInput))?.recovery).toBeUndefined();
            expect(
              world.hostCalls.filter(({ call }) => call.tool === "goat_thread_checkpoint_restore"),
            ).toHaveLength(0);
          }),
        );
      }),
  );

  it.effect.each(["disabled", "authority_changed", "profiles_enabled"] as const)(
    "does not publish an in-flight copy after %s",
    (reason) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const replica = watchReplica(yield* Clock.currentTimeMillis);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        world.hostCall = (call) =>
          call.tool === "goat_thread_checkpoint_capture"
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ status: "captured", replica }),
              )
            : Effect.succeed(
                call.tool === "goat_thread_wait"
                  ? { threadId: target, runId: run1, status: "completed", timedOut: false }
                  : remoteRead({ itemCount: 0 }),
              );
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
            });
            yield* Deferred.await(entered);
            if (reason === "disabled")
              yield* service.register({
                ...replicaWatchInput,
                runId: null,
                checkpointReplication: "off",
              });
            else if (reason === "profiles_enabled")
              yield* world.settings!.updateSettings({ goatclaw: { enabled: true } });
            else world.shells.set(launcher, { ...world.shells.get(launcher), runtimeMode: "auto" });
            yield* Deferred.succeed(release, undefined);
            yield* Queue.take(world.delivered);
            const saved = yield* service.find(replicaWatchInput);
            expect(saved?.replica).toBeUndefined();
            expect(saved?.replicaAttempt?.reason).toBe(
              reason === "profiles_enabled" ? "disabled" : reason,
            );
            expect(
              world.hostCalls.filter(({ call }) => call.tool === "goat_thread_checkpoint_capture"),
            ).toHaveLength(1);
          }),
        );
      }),
  );

  it.effect("resumes an interrupted active follower after a definite destination refusal", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const replica = watchReplica(yield* Clock.currentTimeMillis);
      const activeWait = yield* Deferred.make<void>();
      let activeWaitCount = 0;
      world.hostCall = (call) => {
        if (call.tool === "goat_thread_checkpoint_restore")
          return Effect.succeed({
            operationId: call.arguments.operationId,
            status: "refused",
            threadId: "unused",
            runId: null,
            reason: "project_missing",
          });
        if (call.tool === "goat_thread_checkpoint_capture")
          return Effect.succeed({
            status: "captured",
            replica: { ...replica, runId: call.arguments.runId },
          });
        if (call.tool === "goat_thread_wait") {
          const currentRun = call.arguments.runId;
          if (currentRun === run2 && ++activeWaitCount === 1)
            return Deferred.succeed(activeWait, undefined).pipe(Effect.andThen(Effect.never));
          return Effect.succeed({
            threadId: target,
            runId: currentRun,
            status: "completed",
            timedOut: false,
          });
        }
        return Effect.succeed(remoteRead({ itemCount: 0 }));
      };
      const dir = yield* tempDir;
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...replicaWatchInput,
            checkpointReplication: "on",
            replicaCeiling: "full-access",
          });
          yield* Queue.take(world.delivered);
          yield* service.rearm({ ...replicaWatchInput, runId: run2 });
          yield* Deferred.await(activeWait);
          expect((yield* service.recover(recoveryInput, recoveryGrant)).status).toBe("refused");
          const resumed = yield* Queue.take(world.delivered);
          expect(resumed.text).toContain("finished run run-2");
          expect(activeWaitCount).toBe(2);
          expect((yield* service.find(replicaWatchInput))?.recovery).toBeUndefined();
        }),
      );
    }),
  );

  it.effect("does not repeat a capture claimed before a restart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const entered = yield* Deferred.make<void>();
      world.hostCall = (call) =>
        call.tool === "goat_thread_checkpoint_capture"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(
              call.tool === "goat_thread_wait"
                ? { threadId: target, runId: run1, status: "completed", timedOut: false }
                : remoteRead({ itemCount: 0 }),
            );
      const dir = yield* tempDir;
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...replicaWatchInput,
            checkpointReplication: "on",
            replicaCeiling: "full-access",
          });
          yield* Deferred.await(entered);
          expect((yield* service.find(replicaWatchInput))?.replicaAttempt?.reason).toBe(
            "capturing",
          );
        }),
      );
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          yield* service.find(replicaWatchInput);
          yield* Queue.take(world.delivered);
          expect((yield* service.find(replicaWatchInput))?.replicaAttempt?.reason).toBe(
            "capture_interrupted",
          );
          expect(
            world.hostCalls.filter(({ call }) => call.tool === "goat_thread_checkpoint_capture"),
          ).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect(
    "allows correcting a definitely refused destination without losing report routing",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const replica = watchReplica(yield* Clock.currentTimeMillis);
        const operations: string[] = [];
        world.hostCall = (call) => {
          if (call.tool === "goat_thread_checkpoint_restore") {
            operations.push(String(call.arguments.operationId));
            return Effect.succeed({
              operationId: call.arguments.operationId,
              status: call.arguments.projectId === "missing" ? "refused" : "launched",
              threadId: "replacement",
              runId: call.arguments.projectId === "missing" ? null : "replacement-run",
              reason: "project_missing",
            });
          }
          if (call.host === "destination") return Effect.never;
          if (call.tool === "goat_thread_interrupt")
            return Effect.succeed({ threadId: target, runId: run1, status: "completed" });
          if (call.tool === "goat_thread_checkpoint_capture")
            return Effect.succeed({ status: "captured", replica });
          return Effect.succeed(
            call.tool === "goat_thread_wait"
              ? { threadId: target, runId: run1, status: "completed", timedOut: false }
              : remoteRead({ itemCount: 0 }),
          );
        };
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
              notifyWebhook: true,
            });
            yield* Queue.take(world.delivered);
            expect(
              (yield* service.recover(
                { ...recoveryInput, destinationProjectId: ProjectId.make("missing") },
                recoveryGrant,
              )).status,
            ).toBe("refused");
            expect((yield* service.find(replicaWatchInput))?.recovery).toBeUndefined();
            expect((yield* service.recover(recoveryInput, recoveryGrant)).status).toBe("launched");
            expect(new Set(operations).size).toBe(2);
            expect(
              (yield* service.find({
                launcherThreadId: launcher,
                host: "destination",
                threadId: ThreadId.make("replacement"),
              }))?.notifyWebhook,
            ).toBe(true);
            expect((yield* service.find(replicaWatchInput))?.notifyWebhook).toBe(false);
          }),
        );
      }),
  );

  it.effect(
    "an older unknown reply cannot downgrade a known launch, including offline replay",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const replica = watchReplica(yield* Clock.currentTimeMillis);
        const sent = yield* Deferred.make<string>();
        const release = yield* Deferred.make<void>();
        let destinationDown = false;
        let mutationCalls = 0;
        world.hostCall = (call) => {
          if (
            call.tool === "goat_thread_checkpoint_restore" ||
            call.tool === "goat_thread_checkpoint_reconcile"
          ) {
            mutationCalls++;
            if (destinationDown)
              return Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "destination offline",
                }),
              );
            const operationId = String(call.arguments.operationId);
            if (call.tool === "goat_thread_checkpoint_reconcile")
              return Effect.succeed({
                operationId,
                status: "launched",
                threadId: "replacement",
                runId: "replacement-run",
              });
            return Deferred.succeed(sent, operationId).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                operationId,
                status: "launch_unknown",
                threadId: "replacement",
                runId: null,
              }),
            );
          }
          if (call.host === "destination") return Effect.never;
          if (call.tool === "goat_thread_interrupt")
            return Effect.succeed({ threadId: target, runId: run1, status: "completed" });
          if (call.tool === "goat_thread_checkpoint_capture")
            return Effect.succeed({ status: "captured", replica });
          return Effect.succeed(
            call.tool === "goat_thread_wait"
              ? { threadId: target, runId: run1, status: "completed", timedOut: false }
              : remoteRead({ itemCount: 0 }),
          );
        };
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
            });
            yield* Queue.take(world.delivered);
            const first = yield* service
              .recover(recoveryInput, recoveryGrant)
              .pipe(Effect.forkChild);
            yield* Deferred.await(sent);
            expect((yield* service.recover(recoveryInput, recoveryGrant)).status).toBe("launched");
            yield* Deferred.succeed(release, undefined);
            expect((yield* Fiber.join(first)).status).toBe("launched");
            destinationDown = true;
            expect((yield* service.recover(recoveryInput, recoveryGrant)).status).toBe("launched");
            expect(mutationCalls).toBe(2);
            expect((yield* service.find(replicaWatchInput))?.recovery?.status).toBe("launched");
          }),
        );
      }),
  );

  it.effect("expires payload contents but still reconciles and retains the source fence", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const replica = watchReplica(yield* Clock.currentTimeMillis);
      world.hostCall = (call) => {
        if (call.tool === "goat_thread_checkpoint_restore")
          return Effect.succeed({
            operationId: call.arguments.operationId,
            status: "launch_unknown",
            threadId: "replacement",
            runId: null,
          });
        if (call.tool === "goat_thread_checkpoint_reconcile") {
          expect(call.arguments).not.toHaveProperty("replica");
          return Effect.succeed({
            operationId: call.arguments.operationId,
            status: "launched",
            threadId: "replacement",
            runId: "replacement-run",
          });
        }
        if (call.host === "destination") return Effect.never;
        if (call.tool === "goat_thread_interrupt")
          return Effect.succeed({ threadId: target, runId: run1, status: "completed" });
        if (call.tool === "goat_thread_checkpoint_capture")
          return Effect.succeed({ status: "captured", replica });
        return Effect.succeed(
          call.tool === "goat_thread_wait"
            ? { threadId: target, runId: run1, status: "completed", timedOut: false }
            : remoteRead({ itemCount: 0 }),
        );
      };
      const dir = yield* tempDir;
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...replicaWatchInput,
            checkpointReplication: "on",
            replicaCeiling: "full-access",
          });
          yield* Queue.take(world.delivered);
          expect((yield* service.recover(recoveryInput, recoveryGrant)).status).toBe(
            "launch_unknown",
          );
          yield* service.unwatch(replicaWatchInput);
          yield* TestClock.adjust("8 days");
          const kept = yield* service.find(replicaWatchInput);
          expect(kept?.replica).toBeUndefined();
          expect(kept?.recovery?.status).toBe("launch_unknown");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          expect(yield* fs.readDirectory(path.join(dir, "userdata", "watch-replicas"))).toEqual([]);
          expect((yield* service.recover(recoveryInput, recoveryGrant)).status).toBe("launched");
        }).pipe(Effect.provide(NodeServices.layer)),
      );
    }),
  );

  it.effect.each([undefined, "off"] as const)(
    "does no capture work when host setting is %s",
    (setting) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        if (setting !== undefined) world.hostReplication = setting;
        world.hostCall = (call) =>
          Effect.succeed(
            call.tool === "goat_thread_wait"
              ? { threadId: target, runId: run1, status: "completed", timedOut: false }
              : remoteRead({ itemCount: 0 }),
          );
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register(replicaWatchInput);
            yield* Queue.take(world.delivered);
            expect(
              world.hostCalls.some(({ call }) => call.tool === "goat_thread_checkpoint_capture"),
            ).toBe(false);
          }),
        );
      }),
  );

  it.effect(
    "captures once per completed turn across restart and rejects stale requests and lowered grants",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const replica = watchReplica(yield* Clock.currentTimeMillis);
        world.hostCall = (call) =>
          Effect.succeed(
            call.tool === "goat_thread_checkpoint_capture"
              ? { status: "captured", replica }
              : call.tool === "goat_thread_wait"
                ? { threadId: target, runId: run1, status: "completed", timedOut: false }
                : remoteRead({ itemCount: 0 }),
          );
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
            });
            yield* Queue.take(world.delivered);
            const stored = yield* service.find(replicaWatchInput);
            expect(stored?.replica?.sha256).toBe(replica.sha256);
          }),
        );
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            const again = yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
            });
            expect(again.replicaAttempts).toEqual([run1]);
            expect(
              world.hostCalls.filter(({ call }) => call.tool === "goat_thread_checkpoint_capture"),
            ).toHaveLength(1);
            const denied = yield* service
              .recover(
                recoveryInput,
                Effect.succeed({ runtimeMode: "auto", interactionMode: "default" }),
              )
              .pipe(Effect.result);
            expect(denied._tag).toBe("Failure");
            const stale = yield* service
              .recover({ ...recoveryInput, expectedRunId: run2 }, recoveryGrant)
              .pipe(Effect.result);
            expect(stale._tag).toBe("Failure");
          }),
        );
      }),
  );

  it.effect.each([false, true])(
    "off wins staged ordinary payload publication (reenable=%s)",
    (reenable) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const replica = watchReplica(yield* Clock.currentTimeMillis);
        const staged = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        world.payloadStaged = Deferred.succeed(staged, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        let completedRun = run1;
        world.hostCall = (call) =>
          Effect.succeed(
            call.tool === "goat_thread_checkpoint_capture"
              ? { status: "captured", replica: { ...replica, runId: completedRun } }
              : call.tool === "goat_thread_wait"
                ? { threadId: target, runId: completedRun, status: "completed", timedOut: false }
                : remoteRead({ itemCount: 0 }),
          );
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
            });
            yield* Deferred.await(staged);
            yield* world.settings!.updateSettings({ responseStreamingMode: "turn" });
            yield* world.settings!.updateSettings({
              fleet: {
                hosts: {
                  other: { checkpointReplication: "off" },
                  box: { checkpointReplication: "off" },
                },
              },
            });
            if (reenable)
              yield* world.settings!.updateSettings({
                fleet: { hosts: { box: { checkpointReplication: "on" } } },
              });
            yield* Deferred.succeed(release, undefined);
            yield* Queue.take(world.delivered);
            expect((yield* service.find(replicaWatchInput))?.replica).toBeUndefined();
            expect((yield* service.find(replicaWatchInput))?.replicaAttempt?.reason).toBe(
              "disabled",
            );
          }),
        );
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            expect((yield* service.find(replicaWatchInput))?.replica).toBeUndefined();
            yield* world.settings!.updateSettings({
              fleet: { hosts: { box: { checkpointReplication: "on" } } },
            });
            completedRun = run2;
            yield* service.rearm({ ...replicaWatchInput, runId: run2 });
            yield* Queue.take(world.delivered);
            expect((yield* service.find(replicaWatchInput))?.replica?.runId).toBe(run2);
          }),
        );
      }),
  );

  it.effect("cancelled ordinary publication removes staged payload and restart keeps dedup", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const replica = watchReplica(yield* Clock.currentTimeMillis);
      const staged = yield* Deferred.make<void>();
      world.payloadStaged = Deferred.succeed(staged, undefined).pipe(Effect.andThen(Effect.never));
      world.hostCall = (call) =>
        Effect.succeed(
          call.tool === "goat_thread_checkpoint_capture"
            ? { status: "captured", replica }
            : call.tool === "goat_thread_wait"
              ? { threadId: target, runId: run1, status: "completed", timedOut: false }
              : remoteRead({ itemCount: 0 }),
        );
      const dir = yield* tempDir;
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...replicaWatchInput,
            checkpointReplication: "on",
            replicaCeiling: "full-access",
          });
          yield* Deferred.await(staged);
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.readDirectory(path.join(dir, "userdata", "watch-replicas"))).toEqual([]);
      delete world.payloadStaged;
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          const watch = yield* service.find(replicaWatchInput);
          expect(watch?.replica).toBeUndefined();
          expect(watch?.replicaAttempt?.reason).toBe("capture_interrupted");
          expect(
            world.hostCalls.filter(({ call }) => call.tool === "goat_thread_checkpoint_capture"),
          ).toHaveLength(1);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["completed", "question"] as const)(
    "fences a late %s while recovering and retains it across unwatch and restart",
    (late) =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const replica = watchReplica(yield* Clock.currentTimeMillis);
        const captured = yield* Deferred.make<void>();
        const sourceWaiting = yield* Deferred.make<void>();
        const sourceWaitEnded = yield* Deferred.make<void>();
        const releaseSource = yield* Deferred.make<void>();
        const interrupted = yield* Queue.unbounded<Record<string, unknown>>();
        let sourceOffline = false;
        let sourceReturned = false;
        const operations: string[] = [];
        world.hostCall = (call) => {
          if (call.tool === "goat_thread_checkpoint_restore") {
            const operationId = String(call.arguments.operationId);
            operations.push(operationId);
            return Effect.succeed({
              operationId,
              status: "launched",
              threadId: "replacement",
              runId: "replacement-run",
            });
          }
          if (call.host === "destination") return Effect.never;
          if (call.tool === "goat_thread_interrupt") {
            if (!sourceReturned)
              return Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "offline",
                }),
              );
            return Queue.offer(interrupted, call.arguments).pipe(
              Effect.as({ threadId: target, runId: run2, status: "interrupt_requested" }),
            );
          }
          if (sourceOffline) {
            if (call.tool === "goat_thread_wait")
              return Deferred.succeed(sourceWaiting, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSource)),
                Effect.as({
                  threadId: target,
                  runId: run2,
                  status: late === "completed" ? "completed" : "waiting",
                  timedOut: false,
                  pendingRequestIds: late === "question" ? ["old-question"] : [],
                }),
                Effect.ensuring(Deferred.succeed(sourceWaitEnded, undefined)),
              );
            return Effect.succeed(
              call.tool === "goat_pending_request_list"
                ? { requestIds: ["old-question"] }
                : remoteRead({ itemCount: 0 }),
            );
          }
          if (call.tool === "goat_thread_checkpoint_capture")
            return Deferred.succeed(captured, undefined).pipe(
              Effect.as({ status: "captured", replica }),
            );
          return Effect.succeed(
            call.tool === "goat_thread_wait"
              ? { threadId: target, runId: run1, status: "completed", timedOut: false }
              : remoteRead({ itemCount: 0 }),
          );
        };
        const dir = yield* tempDir;
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            yield* service.register({
              ...replicaWatchInput,
              checkpointReplication: "on",
              replicaCeiling: "full-access",
            });
            yield* Deferred.await(captured);
            yield* Queue.take(world.delivered);
            sourceOffline = true;
            yield* service.rearm({ ...replicaWatchInput, runId: run2 });
            yield* Deferred.await(sourceWaiting);
            const result = yield* service.recover(
              recoveryInput,
              recoveryGrant.pipe(
                Effect.tap(() => Deferred.succeed(releaseSource, undefined)),
                Effect.tap(() => Deferred.await(sourceWaitEnded)),
              ),
            );
            expect(result.status).toBe("launched");
            yield* Deferred.await(sourceWaitEnded);
            const old = yield* service.find(replicaWatchInput);
            expect(old?.recovery?.sourceRunId).toBe(run2);
            yield* service.unwatch(replicaWatchInput);
          }),
        );
        yield* withService(world, dir, (service) =>
          Effect.gen(function* () {
            const recovered = yield* service.register({ ...replicaWatchInput, runId: run2 });
            expect(recovered.recovery?.status).toBe("launched");
            yield* service.rearm({ ...replicaWatchInput, runId: run2 });
            const replay = yield* service.recover(recoveryInput, recoveryGrant);
            expect(replay.status).toBe("launched");
            expect(new Set(operations).size).toBe(1);
            expect(operations).toHaveLength(1);
            expect(world.deliveredLog).toHaveLength(1);
            sourceReturned = true;
            yield* world.settings!.updateSettings({ goatclaw: { enabled: true } });
            yield* TestClock.adjust("2 minutes");
            expect(yield* Queue.size(interrupted)).toBe(0);
            expect((yield* service.find(replicaWatchInput))?.recovery?.sourceInterrupted).toBe(
              false,
            );
            yield* world.settings!.updateSettings({ goatclaw: { enabled: false } });
            world.shells.set(launcher, {
              ...world.shells.get(launcher),
              interactionMode: "plan",
            });
            yield* TestClock.adjust("2 minutes");
            expect(yield* Queue.size(interrupted)).toBe(0);
            expect((yield* service.find(replicaWatchInput))?.recovery?.sourceInterrupted).toBe(
              false,
            );
            world.shells.set(launcher, {
              ...world.shells.get(launcher),
              interactionMode: "default",
            });
            yield* TestClock.adjust("2 minutes");
            const stopped = yield* Queue.take(interrupted);
            expect(stopped.threadId).toBe(target);
            expect(stopped.runId).toBe(run2);
            expect(stopped.stopCascade).toBeUndefined();
            expect(
              world.hostCalls.filter(({ call }) => call.tool === "goat_thread_checkpoint_capture"),
            ).toHaveLength(1);
          }),
        );
      }),
  );
});
