import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import type { LaunchWatch } from "./launchWatch.ts";
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
}

const makeWorld = Effect.gen(function* () {
  const world: World = {
    shells: new Map([
      [launcher, { id: launcher, runtimeMode: "full-access", archivedAt: null, deletedAt: null }],
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
        }),
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        NodeCrypto.layer,
        NodeServices.layer,
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
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-watch-" });
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
          expect(first.text).toContain("goat_pending_request_read");
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
