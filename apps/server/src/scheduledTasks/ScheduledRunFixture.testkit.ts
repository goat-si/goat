import { ScheduledTaskUpsertInput } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { SecretRequestError, type ScheduledTaskWebhookUrlUnavailableReason } from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Runs from "./ScheduledTaskRuns.ts";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import {
  EventId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";

export const layerSink = EventSink.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
);
export const syntheticLaunch = (sink: EventSink.EventSinkV2["Service"]) =>
  Effect.fn("SyntheticSchedule.launch")(function* (
    input: Parameters<Launch.ThreadLaunchService["Service"]["launch"]>[0],
    status: OrchestrationV2Run["status"] = "completed",
  ) {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${input.commandId}`);
    const runId = RunId.make(`run:${input.commandId}`);
    const messageId = input.initialMessage?.messageId;
    if (!messageId) return yield* Effect.die("Synthetic scheduled launch needs its message ID");
    const thread = {
      ...idleThreadProjection(liveThreadShell(threadId)).thread,
      projectId: input.projectId,
    };
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      providerThreadId: null,
      userMessageId: messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: null,
      completedAt: status === "queued" ? null : now,
      checkpointId: null,
      contextHandoffId: null,
    };
    const message: OrchestrationV2ConversationMessage = {
      id: messageId,
      threadId,
      runId,
      nodeId: null,
      role: "user",
      text: "Synthetic scheduled work",
      ...(input.initialMessage?.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: input.initialMessage.scheduledTaskId }),
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: "user",
      creationSource: "web",
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`thread:${input.commandId}`),
          threadId,
          occurredAt: now,
          type: "thread.created",
          payload: thread,
        },
        {
          id: EventId.make(`message:${input.commandId}`),
          threadId,
          occurredAt: now,
          type: "message.updated",
          payload: message,
        },
        {
          id: EventId.make(`run:${input.commandId}`),
          threadId,
          occurredAt: now,
          type: "run.created",
          payload: run,
        },
      ],
    });
    return {
      threadId,
      resumed: false,
      projection: {
        ...idleThreadProjection(liveThreadShell(threadId)),
        thread,
        messages: [message],
        runs: [run],
      },
    };
  });

type LaunchInput = Parameters<Launch.ThreadLaunchService["Service"]["launch"]>[0];
export const syntheticLaunchLayer = (
  launches: Queue.Queue<LaunchInput>,
  options: {
    readonly completedLaunches?: Set<string>;
    readonly failLaunches?: { remaining: number };
    readonly defectLaunches?: { remaining: number };
    readonly runStatus?: OrchestrationV2Run["status"];
    readonly failAfterAcceptance?: boolean;
    readonly returnOnly?: boolean;
    readonly gate?: Deferred.Deferred<void>;
    readonly gateForTask?: (input: LaunchInput) => Deferred.Deferred<void> | undefined;
  },
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const launch = syntheticLaunch(sink);
      const completed = new Map<string, Effect.Success<ReturnType<typeof launch>>>();
      return Layer.mock(Launch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            const commandId = input.commandId;
            if (commandId === undefined)
              return yield* Effect.die("Synthetic launch requires commandId");
            return yield* Effect.gen(function* () {
              const cached = completed.get(commandId);
              if (options.completedLaunches?.has(commandId) && cached) return cached;
              yield* Queue.offer(launches, input);
              const gate = options.gateForTask?.(input) ?? options.gate;
              if (gate) yield* Deferred.await(gate);
              if (options.defectLaunches && options.defectLaunches.remaining-- > 0)
                return yield* Effect.die("Synthetic uncertain dispatch defect");
              if (options.failLaunches && options.failLaunches.remaining-- > 0)
                return yield* new Launch.ThreadLaunchError({
                  operation: "dispatch-message",
                  commandId,
                  projectId: input.projectId,
                  cause: "Synthetic pre-command failure.",
                });
              if (options.returnOnly) {
                const threadId = ThreadId.make("synthetic:return-only");
                return {
                  threadId,
                  resumed: false,
                  projection: idleThreadProjection(liveThreadShell(threadId)),
                };
              }
              const result = yield* launch(input, options.runStatus);
              if (options.failAfterAcceptance)
                return yield* new Launch.ThreadLaunchError({
                  operation: "dispatch-message",
                  commandId,
                  projectId: input.projectId,
                  cause: "Synthetic error after commit.",
                });
              completed.set(commandId, result);
              options.completedLaunches?.add(commandId);
              return result;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new Launch.ThreadLaunchError({
                    operation: "dispatch-message",
                    commandId,
                    projectId: input.projectId,
                    cause,
                  }),
              ),
            );
          }),
      });
    }),
  ).pipe(Layer.provide(layerSink));

export const withWebhookService = <A, E>(
  body: (input: {
    readonly runs: Runs.ScheduledTaskRuns["Service"];
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly launches: Queue.Queue<LaunchInput>;
    readonly sql: SqlClient.SqlClient;
    readonly secretsByRef: Map<string, string>;
  }) => Effect.Effect<A, E, never>,
  options: {
    readonly unavailableReason?: ScheduledTaskWebhookUrlUnavailableReason;
    readonly onFrame?: () => void;
    readonly frameGate?: {
      readonly started: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly completedLaunches?: Set<string>;
    readonly failLaunches?: { remaining: number };
    readonly defectLaunches?: { remaining: number };
    readonly runStatus?: OrchestrationV2Run["status"];
    readonly failAfterAcceptance?: boolean;
    readonly returnOnly?: boolean;
    readonly gate?: Deferred.Deferred<void>;
    readonly gateForTask?: (input: LaunchInput) => Deferred.Deferred<void> | undefined;
    readonly relayHookBaseUrl?: string;
    readonly sql?: SqlClient.SqlClient;
    readonly workers?: Map<string, Effect.Effect<void>>;
  } = {},
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<LaunchInput>();
    const secretsByRef = new Map<string, string>();
    const layerDependencies = Layer.mergeAll(
      options.frameGate === undefined && options.onFrame === undefined
        ? NodePlatformCrypto.layer
        : Layer.effect(
            Crypto.Crypto,
            Effect.gen(function* () {
              const crypto = yield* Crypto.Crypto;
              return {
                ...crypto,
                randomBytes: (size: number) =>
                  Effect.suspend(() => {
                    if (size === 6) options.onFrame?.();
                    return size === 6 && options.frameGate !== undefined
                      ? Deferred.succeed(options.frameGate.started, undefined).pipe(
                          Effect.andThen(Deferred.await(options.frameGate.release)),
                          Effect.andThen(crypto.randomBytes(size)),
                        )
                      : crypto.randomBytes(size);
                  }),
              };
            }),
          ).pipe(Layer.provide(NodePlatformCrypto.layer)),
      options.workers === undefined
        ? Scheduler.layer
        : Layer.succeed(Scheduler.Scheduler, {
            register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                options.workers?.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
              }),
          }),
      syntheticLaunchLayer(launches, options),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({
        consume: ({ ref }) => {
          const value = secretsByRef.get(ref);
          secretsByRef.delete(ref);
          return value === undefined
            ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
            : Effect.succeed(value);
        },
      }),
      Layer.succeed(
        ScheduledTaskService.ScheduledTaskWebhookOrigin,
        Effect.succeed({
          relayHookBaseUrl: options.relayHookBaseUrl ?? null,
          unavailableReason: options.unavailableReason,
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* Effect.gen(function* () {
        return yield* Runs.ScheduledTaskRuns;
      }).pipe(Effect.provide(Runs.layer));
      return yield* body({ service, launches, sql, secretsByRef, runs });
    }).pipe(
      Effect.provide(
        Layer.fresh(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))),
      ),
    );
  }).pipe(
    Effect.provide(
      options.sql === undefined
        ? SqlitePersistence.layerMemory
        : Layer.succeed(SqlClient.SqlClient, options.sql),
    ),
  );

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
export const waitForSpan = <A, E, R>(work: Effect.Effect<A, E, R>, name: string) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === name) Deferred.doneUnsafe(done, Effect.void);
        };
        return span;
      },
    });
    const result = yield* work.pipe(Effect.withTracer(tracer));
    yield* Deferred.await(done);
    return result;
  });

export const drainPendingDispatch = (workers: Map<string, Effect.Effect<void>>) =>
  waitForSpan(
    workers.get("webhook-coalescing") ?? Effect.die("Synthetic coalescing worker missing"),
    "ScheduledTaskService.dispatchPendingWebhook",
  );

export const webhookTaskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:hook",
    title: "Review PRs",
    prompt: "Review this PR: {{body.pull_request.url}}",
    enabled: true,
    schedule: { type: "webhook" },
    projectId: "project-webhook",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

export const pullRequestBody = new TextEncoder().encode(
  JSON.stringify({ pull_request: { url: "https://github.com/org/repo/pull/45" } }),
);

export const requestFor = (
  task: { readonly id: string; readonly webhook?: { readonly path: string } | undefined },
  overrides: Partial<ScheduledTaskService.WebhookTriggerRequest> = {},
): ScheduledTaskService.WebhookTriggerRequest => ({
  hookId: task.id,
  token: task.webhook?.path.split("/").at(-1) ?? "",
  method: "POST",
  path: `/api/hooks/${task.id}`,
  query: "",
  headers: { "content-type": "application/json" },
  body: pullRequestBody,
  bodyText: new TextDecoder().decode(pullRequestBody),
  ...overrides,
});
