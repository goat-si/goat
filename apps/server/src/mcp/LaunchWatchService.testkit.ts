import { expect } from "@effect/vitest";
import * as PressureNudger from "../fleet/pressure/PressureNudger.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import {
  CommandId,
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

/** The world a LaunchWatchService test controls, and the service built over it. */
export const launcher = ThreadId.make("launcher");
export const target = ThreadId.make("target");
export const projectId = ProjectId.make("project");
export const run1 = RunId.make("run-1");
export const run2 = RunId.make("run-2");

type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type WaitAnswer = Effect.Effect<
  ThreadManagementService.ThreadManagementWaitResult,
  ThreadManagementService.ThreadManagementError
>;

/** Everything the service sees of the world, under the test's control. */
export interface World {
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
  /** Command ids the orchestrator accepted; like its receipts, a repeat queues nothing new. */
  readonly accepted: Set<string>;
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

export const makeWorld = Effect.gen(function* () {
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
    accepted: new Set(),
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
    if (world.accepted.has(commandId)) return Effect.succeed({} as never);
    world.accepted.add(commandId);
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
export const withService = <A, E>(
  world: World,
  baseDir: string,
  body: (service: LaunchWatchService.LaunchWatchServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* LaunchWatchService.LaunchWatchService;
    return yield* body(service);
  }).pipe(Effect.provide(layerFor(world, baseDir)));

export const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "goat-launch-watch-" });
}).pipe(Effect.provide(NodeServices.layer));

/**
 * Advances the test clock until milestone arrives, for followers sleeping
 * through backoff or a retry pause.
 */
export const advanceUntil = <A, E>(milestone: Effect.Effect<A, E>) =>
  Effect.raceFirst(
    milestone,
    Effect.forever(TestClock.adjust("10 seconds").pipe(Effect.andThen(Effect.yieldNow))),
  );

export const finished = (runId: RunId, status: "completed" | "failed" = "completed"): WaitAnswer =>
  Effect.succeed({ threadId: target, run: { id: runId, status } as never, timedOut: false });

export const stillRunning = (runId: RunId): WaitAnswer =>
  Effect.succeed({
    threadId: target,
    run: { id: runId, status: "running" } as never,
    timedOut: true,
  });

export const local = { launcherThreadId: launcher, host: null, threadId: target } as const;

export const watchLocal = (
  service: LaunchWatchService.LaunchWatchServiceShape,
  runId: RunId | null,
) => service.register({ ...local, projectId, title: "Fix the flake", runId });

export const watchRemote = (service: LaunchWatchService.LaunchWatchServiceShape, runId: RunId) =>
  service.register({
    launcherThreadId: launcher,
    host: " box ",
    threadId: target,
    projectId: null,
    title: null,
    runId,
  });

export const pendingRuns = (service: LaunchWatchService.LaunchWatchServiceShape) =>
  service.list(launcher).pipe(Effect.map(([watch]) => watch?.pendingRuns ?? null));
