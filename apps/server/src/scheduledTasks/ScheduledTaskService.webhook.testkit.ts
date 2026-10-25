// @effect-diagnostics nodeBuiltinImport:off - Effect's Crypto has no createHmac
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import {
  ScheduledTaskUpsertInput,
  type ScheduledTaskWebhookUrlUnavailableReason,
  SecretRequestError,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

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

export const drainPendingDispatch = (workers: Map<string, Effect.Effect<void>>) => {
  const work = workers.get("webhook-coalescing");
  if (work === undefined) return Effect.die("webhook-coalescing worker was not registered");
  return waitForSpan(work, "ScheduledTaskService.dispatchPendingWebhook");
};

type LaunchInput = ThreadLaunchService.ThreadLaunchInput;

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

export const withService = <A, E>(
  body: (input: {
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
    readonly gate?: Deferred.Deferred<void>;
    readonly gateForTask?: (input: LaunchInput) => Deferred.Deferred<void> | undefined;
    readonly relayHookBaseUrl?: string;
    readonly sql?: SqlClient.SqlClient;
    readonly workers?: Map<string, Effect.Effect<void>>;
  } = {},
) =>
  Effect.gen(function* () {
    const workers = options.workers;
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
      workers === undefined
        ? Scheduler.layer
        : Layer.succeed(Scheduler.Scheduler, {
            register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
              }),
          }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Effect.suspend(() => {
            if (options.completedLaunches?.has(input.commandId))
              return Effect.succeed({ threadId: "thread-1", resumed: false } as never);
            options.completedLaunches?.add(input.commandId);
            const gate = options.gateForTask?.(input) ?? options.gate;
            return Queue.offer(launches, input).pipe(
              Effect.andThen(gate === undefined ? Effect.void : Deferred.await(gate)),
              Effect.andThen(
                Effect.sync(() => {
                  if (options.failLaunches && options.failLaunches.remaining-- > 0)
                    throw new Error("injected start failure");
                }),
              ),
              Effect.as({ threadId: "thread-1", resumed: false } as never),
            );
          }),
      }),
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
      return yield* body({ service, launches, sql, secretsByRef });
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
