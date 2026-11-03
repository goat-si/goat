import {
  CommandId,
  latestProviderTurnForAttempt,
  type ProviderInstanceId,
  type ProviderSessionId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ServerSettings from "../serverSettings.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexClient from "effect-codex-app-server/client";
import * as Detached from "./CodexDetachedAppServerLive.ts";
import {
  CodexDetachedAppServerError,
  type DetachedClassification,
} from "./CodexDetachedAppServer.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { servesSession } from "./CodexRecordSessions.ts";
import { containRecoveryThread, type RecoveryRun } from "./CodexSurvivorRecoveryContainment.ts";

export interface CodexSurvivorBinding {
  readonly instanceId: ProviderInstanceId;
  readonly recordName: string;
  /** The session of the record; bindings never cross from one session's process to another's. */
  readonly providerSessionId?: ProviderSessionId | undefined;
  readonly threadId: ThreadId;
  readonly sourceRunId: RunId;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
}

export interface CodexStopObligation {
  readonly threadId: ThreadId;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
}

export interface CodexGoalBlock {
  readonly threadId: ThreadId;
  readonly nativeThreadId: string;
}

export interface CodexInstanceRecordKey {
  readonly instanceId: ProviderInstanceId;
  readonly recordName: string;
  readonly providerSessionId?: ProviderSessionId | undefined;
}

export const readGoalStatus = Effect.fn("CodexSurvivors.readGoalStatus")(
  (request: Effect.Effect<{ readonly goal?: unknown | null }, CodexErrors.CodexAppServerError>) =>
    request.pipe(
      Effect.map((result) => (result.goal == null ? ("none" as const) : ("goal" as const))),
      Effect.catchTags({
        CodexAppServerRequestError: (error) =>
          error.code === -32600 && error.errorMessage === "goals feature is disabled"
            ? Effect.succeed("disabled" as const)
            : Effect.fail(error),
      }),
    ),
);

export const readGoalReleaseStatus = Effect.fn("CodexSurvivors.readGoalReleaseStatus")(
  (
    request: Effect.Effect<
      { readonly goal?: { readonly status: string } | null },
      CodexErrors.CodexAppServerError
    >,
  ) =>
    readGoalStatus(
      request.pipe(
        Effect.map(({ goal }) => ({
          goal:
            goal == null || goal.status === "paused" || goal.status === "complete" ? null : goal,
        })),
      ),
    ),
);

export const classifyCandidate = Effect.fn("CodexSurvivors.classifyCandidate")(function* <
  E,
  F,
  G,
  H,
>(input: {
  readonly binding: CodexSurvivorBinding;
  readonly stopRequested: boolean;
  readonly readGoal: Effect.Effect<"none" | "disabled" | "goal", E>;
  readonly recordGoal: (
    key: CodexInstanceRecordKey,
    block: CodexGoalBlock,
  ) => Effect.Effect<void, F>;
  readonly recordStop: (
    key: CodexInstanceRecordKey,
    stop: CodexStopObligation,
  ) => Effect.Effect<void, G>;
  readonly interrupt: (nativeThreadId: string, nativeTurnId: string) => Effect.Effect<void, H>;
  readonly confirmTerminal: Effect.Effect<boolean | "completed" | "failed" | "interrupted", H>;
}) {
  const goal = yield* input.readGoal.pipe(Effect.option);
  const hasGoal = Option.isNone(goal) || goal.value === "goal";
  if (!hasGoal && !input.stopRequested) return "survivor" as const;
  const binding = input.binding;
  if (hasGoal && Option.isNone(yield* input.recordGoal(binding, binding).pipe(Effect.option)))
    return "blocked" as const;
  if (Option.isNone(yield* input.recordStop(binding, binding).pipe(Effect.option)))
    return "blocked" as const;
  yield* input.interrupt(binding.nativeThreadId, binding.nativeTurnId).pipe(Effect.option);
  const confirmed = yield* input.confirmTerminal.pipe(Effect.orElseSucceed(() => false));
  return confirmed === "completed" || confirmed === "failed"
    ? confirmed
    : confirmed
      ? ("stopped" as const)
      : ("blocked" as const);
});

export const classifyOnControl = Effect.fn("CodexSurvivors.classifyOnControl")(function* <
  E,
  F,
>(input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly binding: CodexSurvivorBinding;
  readonly stopRequested: boolean;
  readonly recordGoal: (
    key: CodexInstanceRecordKey,
    block: CodexGoalBlock,
  ) => Effect.Effect<void, E>;
  readonly recordStop: (
    key: CodexInstanceRecordKey,
    stop: CodexStopObligation,
  ) => Effect.Effect<void, F>;
}) {
  const { client, binding } = input;
  const terminal = yield* Deferred.make<"completed" | "failed" | "interrupted">();
  yield* client.setRequestGuard(() =>
    Effect.fail(
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "The server is recovering this Codex thread.",
      ),
    ),
  );
  yield* client.handleServerNotification("turn/completed", (event) =>
    event.threadId === binding.nativeThreadId &&
    event.turn.id === binding.nativeTurnId &&
    event.turn.status !== "inProgress"
      ? Deferred.succeed(terminal, event.turn.status).pipe(Effect.asVoid)
      : Effect.void,
  );
  const readGoal = readGoalStatus(
    client.request("thread/goal/get", { threadId: binding.nativeThreadId }),
  ).pipe(Effect.timeoutOption("5 seconds"), Effect.flatMap(Effect.fromOption));
  const confirmTerminal = Effect.gen(function* () {
    const page = yield* client.request("thread/turns/list", {
      threadId: binding.nativeThreadId,
      limit: 100,
    });
    const turn = page.data.find((entry) => entry.id === binding.nativeTurnId);
    if (turn && turn.status !== "inProgress") return turn.status;
    return yield* Deferred.await(terminal);
  }).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.map((result) => (Option.isSome(result) ? result.value : false)),
  );
  return yield* classifyCandidate({
    binding,
    stopRequested: input.stopRequested,
    readGoal,
    recordGoal: input.recordGoal,
    recordStop: input.recordStop,
    interrupt: (threadId, turnId) =>
      client
        .request("thread/resume", { threadId, excludeTurns: true })
        .pipe(
          Effect.andThen(client.request("turn/interrupt", { threadId, turnId })),
          Effect.asVoid,
        ),
    confirmTerminal,
  });
});

export class CodexSurvivors extends Context.Service<
  CodexSurvivors,
  {
    readonly list: Effect.Effect<ReadonlyArray<CodexSurvivorBinding>>;
    /** Threads whose queued starts must wait: an unsettled survivor or a stop fence. */
    readonly startBlockedThreads: Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly setStartWake: (wake: Effect.Effect<void>) => Effect.Effect<void>;
    readonly release: (binding: CodexSurvivorBinding) => Effect.Effect<void>;
    readonly blockThread?: (threadId: ThreadId) => Effect.Effect<void>;
    readonly classifyRecord: (
      key: CodexInstanceRecordKey,
    ) => Effect.Effect<DetachedClassification, CodexDetachedAppServerError>;
    readonly readExistingGoal?: (
      key: CodexInstanceRecordKey,
      nativeThreadId: string,
    ) => Effect.Effect<"none" | "disabled" | "goal", CodexDetachedAppServerError>;
    readonly readExistingTurn?: (
      key: CodexInstanceRecordKey,
      nativeThreadId: string,
      nativeTurnId: string,
    ) => Effect.Effect<
      "running" | "completed" | "failed" | "interrupted" | "unknown",
      CodexDetachedAppServerError
    >;
    readonly classifyExisting: (
      binding: CodexSurvivorBinding,
      stopRequested: boolean,
    ) => Effect.Effect<
      "survivor" | "stopped" | "blocked" | "completed" | "failed",
      CodexDetachedAppServerError
    >;
    readonly replace: (bindings: ReadonlyArray<CodexSurvivorBinding>) => Effect.Effect<void>;
    readonly get: (
      instanceId: ProviderInstanceId,
      threadId: ThreadId,
    ) => Effect.Effect<CodexSurvivorBinding | undefined>;
    readonly getGoalBlocks: (
      threadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly record: CodexInstanceRecordKey; readonly block: CodexGoalBlock }>
    >;
    readonly listGoalBlocksByInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly record: CodexInstanceRecordKey; readonly block: CodexGoalBlock }>
    >;
    readonly getStopObligations: (threadId: ThreadId) => Effect.Effect<
      ReadonlyArray<{
        readonly record: CodexInstanceRecordKey;
        readonly block: CodexStopObligation;
      }>
    >;
    readonly recordStopObligation: (
      record: CodexInstanceRecordKey,
      obligation: CodexStopObligation,
    ) => Effect.Effect<void, CodexDetachedAppServerError>;
    readonly clearStopObligation: (
      record: CodexInstanceRecordKey,
      obligation: CodexStopObligation,
    ) => Effect.Effect<void, CodexDetachedAppServerError>;
    readonly recordGoalBlock: (
      record: CodexInstanceRecordKey,
      block: CodexGoalBlock,
    ) => Effect.Effect<void, CodexDetachedAppServerError>;
    readonly clearGoalBlock: (
      record: CodexInstanceRecordKey,
      block: CodexGoalBlock,
    ) => Effect.Effect<void, CodexDetachedAppServerError>;
    readonly hasGoalBlock: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly ensureAdmission: (
      threadId: ThreadId,
      options?: {
        readonly allowGoalControl?: boolean;
        /** The thread's project setting; without it the turn is assumed to use the socket. */
        readonly survival?: "off" | "restart" | "always";
      },
    ) => Effect.Effect<void, CodexDetachedAppServerError>;
  }
>()("goat/provider/CodexSurvivors") {}

export const layer = Layer.effect(
  CodexSurvivors,
  Effect.gen(function* () {
    const detached = yield* Detached.CodexDetachedAppServers;
    const bindings = yield* Ref.make<ReadonlyArray<CodexSurvivorBinding>>([]);
    const blockedThreads = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
    let wakeStarts: Effect.Effect<void> = Effect.void;
    const wake = Effect.suspend(() => wakeStarts);
    return CodexSurvivors.of({
      startBlockedThreads: Effect.gen(function* () {
        const current = yield* Ref.get(bindings);
        const fenced = yield* detached.stopFencedThreads;
        return [...new Set([...current.map((binding) => binding.threadId), ...fenced])];
      }),
      setStartWake: Effect.fn("CodexSurvivors.setStartWake")((effect) =>
        Effect.sync(() => {
          wakeStarts = effect;
        }),
      ),
      release: Effect.fn("CodexSurvivors.release")((binding) =>
        Ref.update(bindings, (current) =>
          current.filter(
            (value) =>
              value.instanceId !== binding.instanceId ||
              value.threadId !== binding.threadId ||
              value.nativeTurnId !== binding.nativeTurnId,
          ),
        ).pipe(Effect.andThen(wake)),
      ),
      list: Ref.get(bindings),
      blockThread: Effect.fn("CodexSurvivors.blockThread")((threadId) =>
        Ref.update(blockedThreads, (current) => new Set([...current, threadId])),
      ),
      classifyRecord: detached.classifyRecord,
      readExistingTurn: Effect.fn("CodexSurvivors.readExistingTurn")(
        function* (key, nativeThreadId, nativeTurnId) {
          const result = yield* Effect.gen(function* () {
            const existing = yield* detached.connectExisting(key.instanceId, key.recordName);
            const context = yield* Layer.build(CodexClient.layerMessageChannel(existing.channel));
            const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
            yield* client.setRequestGuard(() =>
              Effect.fail(
                CodexErrors.CodexAppServerRequestError.invalidRequest(
                  "The server is recovering this Codex thread.",
                ),
              ),
            );
            yield* client.request("initialize", buildCodexInitializeParams());
            yield* client.notify("initialized", undefined);
            const page = yield* client.request("thread/turns/list", {
              threadId: nativeThreadId,
              limit: 100,
            });
            const turn = page.data.find((value) => value.id === nativeTurnId);
            return turn === undefined
              ? ("unknown" as const)
              : turn.status === "inProgress"
                ? ("running" as const)
                : turn.status;
          }).pipe(
            Effect.scoped,
            Effect.timeoutOption("15 seconds"),
            Effect.mapError(
              (cause) =>
                new CodexDetachedAppServerError({
                  detail: "Could not check the Codex turn.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(result))
            return yield* new CodexDetachedAppServerError({
              detail: "Could not check the Codex turn.",
            });
          return result.value;
        },
      ),
      readExistingGoal: Effect.fn("CodexSurvivors.readExistingGoal")(
        function* (key, nativeThreadId) {
          const result = yield* Effect.gen(function* () {
            const existing = yield* detached.connectExisting(key.instanceId, key.recordName);
            const context = yield* Layer.build(CodexClient.layerMessageChannel(existing.channel));
            const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
            yield* client.setRequestGuard(() =>
              Effect.fail(
                CodexErrors.CodexAppServerRequestError.invalidRequest(
                  "The server is recovering this Codex thread.",
                ),
              ),
            );
            yield* client.request("initialize", buildCodexInitializeParams());
            yield* client.notify("initialized", undefined);
            return yield* readGoalReleaseStatus(
              client.request("thread/goal/get", { threadId: nativeThreadId }),
            );
          }).pipe(
            Effect.scoped,
            Effect.timeoutOption("15 seconds"),
            Effect.mapError(
              (cause) =>
                new CodexDetachedAppServerError({
                  detail: "Could not check the Codex goal.",
                  cause,
                }),
            ),
          );
          if (Option.isNone(result))
            return yield* new CodexDetachedAppServerError({
              detail: "Could not check the Codex goal.",
            });
          return result.value;
        },
      ),
      classifyExisting: Effect.fn("CodexSurvivors.classifyExisting")(function* (
        binding: CodexSurvivorBinding,
        stopRequested: boolean,
      ) {
        const result = yield* Effect.gen(function* () {
          const existing = yield* detached.connectExisting(binding.instanceId, binding.recordName);
          const context = yield* Layer.build(CodexClient.layerMessageChannel(existing.channel));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          yield* client.setRequestGuard(() =>
            Effect.fail(
              CodexErrors.CodexAppServerRequestError.invalidRequest(
                "The server is recovering this Codex thread.",
              ),
            ),
          );
          yield* client.request("initialize", buildCodexInitializeParams());
          yield* client.notify("initialized", undefined);
          return yield* classifyOnControl({
            client,
            binding,
            stopRequested,
            recordGoal: detached.recordGoalBlock,
            recordStop: detached.recordStopObligation,
          });
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (cause) =>
              new CodexDetachedAppServerError({
                detail: "Could not classify the existing Codex turn.",
                cause,
              }),
          ),
          Effect.timeoutOption("15 seconds"),
        );
        if (Option.isNone(result))
          return yield* new CodexDetachedAppServerError({
            detail: "Could not classify the existing Codex turn.",
          });
        return result.value;
      }),
      replace: Effect.fn("CodexSurvivors.replace")((value: ReadonlyArray<CodexSurvivorBinding>) =>
        Ref.set(bindings, value).pipe(Effect.andThen(wake)),
      ),
      get: Effect.fn("CodexSurvivors.get")((instanceId: ProviderInstanceId, threadId: ThreadId) =>
        Ref.get(bindings).pipe(
          Effect.map((values) =>
            values.find((value) => value.instanceId === instanceId && value.threadId === threadId),
          ),
        ),
      ),
      getGoalBlocks: detached.getGoalBlocks,
      listGoalBlocksByInstance: detached.listGoalBlocksByInstance,
      getStopObligations: detached.getStopObligations,
      recordStopObligation: Effect.fn("CodexSurvivors.recordStopObligation")((key, stop) =>
        detached.recordStopObligation(key, stop).pipe(Effect.ensuring(wake)),
      ),
      clearStopObligation: Effect.fn("CodexSurvivors.clearStopObligation")((key, stop) =>
        detached.clearStopObligation(key, stop).pipe(Effect.ensuring(wake)),
      ),
      recordGoalBlock: detached.recordGoalBlock,
      clearGoalBlock: detached.clearGoalBlock,
      hasGoalBlock: detached.hasGoalBlock,
      ensureAdmission: Effect.fn("CodexSurvivors.ensureAdmission")(function* (threadId, options) {
        if ((yield* Ref.get(blockedThreads)).has(threadId))
          return yield* new CodexDetachedAppServerError({
            detail:
              "The Codex process for this thread could not be verified. The previous turn may still be running.",
          });
        const survival = options?.survival;
        const stdio =
          survival !== undefined &&
          !Detached.shouldUseCodexSocketTransport(
            Detached.codexTransportMode(detached),
            survival,
          ) &&
          !(yield* Ref.get(bindings)).some((binding) => binding.threadId === threadId);
        yield* detached.ensureAdmission(threadId, {
          allowGoalControl: options?.allowGoalControl === true,
          stdio,
        });
      }),
    });
  }),
);

/** Protection is recorded with each retention, so an interrupted pass leaves the two consistent. */
export const prepareShutdownSurvivors = Effect.fn("CodexSurvivors.prepareShutdownSurvivors")(
  function* (input: {
    readonly detached: Detached.CodexDetachedAppServers["Service"];
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
    readonly sink: EventSink.EventSinkV2["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
    readonly stopKind: "quit" | "restart";
    readonly bindings: ReadonlyArray<CodexSurvivorBinding>;
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly protect: { readonly threads: Set<ThreadId>; readonly sessions: Set<string> };
  }) {
    const settings = yield* input.settings.getSettings;
    const records = yield* input.detached.loadRecords;
    if (!records.some((item) => item.state === "running" && item.stderrMode === "discard")) return;
    const prepared = new Map<
      string,
      { setting: "restart" | "always"; threads: Set<ThreadId>; sessions: Set<string> }
    >();
    const prepareThread = Effect.fn("CodexSurvivors.prepareShutdownSurvivorThread")(function* (
      threadId: ThreadId,
    ) {
      const projection = yield* input.projections.getRuntimeRecoveryProjection(threadId);
      const setting = resolveProjectSettings(settings, projection.thread.projectId).settings
        .codexTurnsSurviveServerStop;
      if (setting === "off" || (setting === "restart" && input.stopKind !== "restart")) return;
      for (const run of projection.runs) {
        const binding = input.bindings.find(
          (value) => value.threadId === threadId && value.sourceRunId === run.id,
        );
        if (
          (!["preparing", "starting", "running", "waiting"].includes(run.status) &&
            !(run.status === "cancelled" && binding)) ||
          !run.activeAttemptId
        )
          continue;
        const thread = projection.providerThreads.find((item) => item.id === run.providerThreadId);
        if (thread?.driver !== "codex") continue;
        const matches = records.filter(
          (item) =>
            servesSession(item, run.providerInstanceId, thread.providerSessionId) &&
            item.state === "running" &&
            item.stderrMode === "discard" &&
            (binding === undefined || binding.recordName === item.name),
        );
        const record = matches[0];
        if (!record || matches.length !== 1) continue;
        const ancestry = yield* input.projections.getThreadRecords(threadId, ["providerTurns"], {
          ancestryRunIds: [run.id],
        });
        const turn = latestProviderTurnForAttempt(ancestry.providerTurns, run.activeAttemptId);
        if (turn?.status !== "running") continue;
        const sourceRunId = run.restartContinuationOfRunId ?? run.id;
        const commandId = CommandId.make(`command:restart-prepare:${sourceRunId}`);
        yield* input.sink.writeWithEffects({
          commandId,
          events: [],
          effects: [
            {
              id: `effect:restart-continuation:${sourceRunId}`,
              commandId,
              threadId,
              request: { type: "provider-runtime.continue", sourceRunId },
            },
          ],
        });
        const entry = prepared.get(record.name) ?? {
          setting,
          threads: new Set(),
          sessions: new Set(),
        };
        entry.threads.add(threadId);
        if (thread.providerSessionId != null) entry.sessions.add(thread.providerSessionId);
        prepared.set(record.name, entry);
      }
    });
    const candidates = new Set([
      ...input.threadIds,
      ...input.bindings.map((item) => item.threadId),
    ]);
    yield* Effect.forEach(
      candidates,
      (threadId) =>
        prepareThread(threadId).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Failed to prepare a Codex turn to survive shutdown", {
                threadId,
                cause,
              }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    // An app-server that cannot be retained closes with its session; its thread stays unprotected.
    yield* Effect.forEach(
      prepared,
      ([name, entry]) =>
        Effect.uninterruptibleMask((restore) =>
          restore(
            input.detached.retainOnClose(name, {
              setting: entry.setting,
              stopKind: input.stopKind,
              prepared: true,
            }),
          ).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("Codex app-server not retained for shutdown", {
                  name,
                  cause,
                }).pipe(Effect.as(false)),
            ),
            Effect.tap((retained) =>
              Effect.sync(() => {
                if (!retained) return;
                for (const threadId of entry.threads) input.protect.threads.add(threadId);
                for (const sessionId of entry.sessions) input.protect.sessions.add(sessionId);
              }),
            ),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  },
);

/** Blocks one binding's thread when its records are inconsistent; recovery continues for the rest. */
export interface SurvivorBindingContainment {
  readonly survivors: CodexSurvivors["Service"];
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
  readonly onBlocked: (binding: CodexSurvivorBinding) => Effect.Effect<void>;
}

export const survivorSessionIds = Effect.fn("CodexSurvivors.survivorSessionIds")(function* (input: {
  readonly bindings: ReadonlyArray<CodexSurvivorBinding>;
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly contain: SurvivorBindingContainment;
}) {
  const ids = new Set<string>();
  for (const binding of input.bindings) {
    yield* containRecoveryThread({
      ...input.contain,
      projections: input.projections,
      threadId: binding.threadId,
      run: () => undefined,
      onBlocked: input.contain.onBlocked(binding),
      recover: Effect.gen(function* () {
        const projection = yield* input.projections.getRuntimeRecoveryProjection(binding.threadId);
        const thread = projection.providerThreads.find(
          (thread) =>
            thread.providerInstanceId === binding.instanceId &&
            thread.nativeThreadRef?.nativeId === binding.nativeThreadId,
        );
        if (!thread?.providerSessionId)
          return yield* new CodexDetachedAppServerError({
            detail: "The Codex survivor session is unavailable.",
          });
        ids.add(thread.providerSessionId);
      }),
    });
  }
  return ids;
});

export const prepareContinuations = Effect.fn("CodexSurvivors.prepareContinuations")(
  function* (input: {
    readonly bindings: ReadonlyArray<CodexSurvivorBinding>;
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
    readonly sink: EventSink.EventSinkV2["Service"];
    readonly outbox: EffectOutbox.EffectOutboxV2["Service"];
    readonly ids: IdAllocator.IdAllocatorV2["Service"];
    readonly contain: SurvivorBindingContainment;
  }) {
    for (const binding of input.bindings) {
      let currentRun: RecoveryRun | undefined;
      yield* containRecoveryThread({
        ...input.contain,
        projections: input.projections,
        threadId: binding.threadId,
        run: () => currentRun,
        onBlocked: input.contain.onBlocked(binding),
        recover: Effect.gen(function* () {
          const projection = yield* input.projections.getRuntimeRecoveryProjection(
            binding.threadId,
          );
          const continuation = projection.runs.find(
            (run) =>
              run.restartContinuationOfRunId === binding.sourceRunId &&
              ["preparing", "starting", "running", "waiting"].includes(run.status),
          );
          currentRun = continuation;
          const source =
            continuation ??
            projection.runs.find((run) => run.id === binding.sourceRunId) ??
            (yield* input.projections.getThreadRecords(binding.threadId, ["runs"], {
              runIds: [binding.sourceRunId],
            })).runs[0];
          if (!source)
            return yield* new CodexDetachedAppServerError({
              detail: "The Codex survivor source run is unavailable.",
            });
          if (source.status === "cancelled") {
            if (
              !(yield* input.outbox.requeueSurvivorContinuation(
                binding.threadId,
                binding.sourceRunId,
              ))
            )
              return yield* new CodexDetachedAppServerError({
                detail: "The Codex survivor continuation is unavailable.",
              });
            return;
          }
          if (!source.activeAttemptId)
            return yield* new CodexDetachedAppServerError({
              detail: "The Codex survivor attempt is unavailable.",
            });
          const now = yield* DateTime.now;
          const commandId = CommandId.make(`command:restart-survivor:${binding.sourceRunId}`);
          const effect = {
            id: `effect:restart-continuation:${binding.sourceRunId}`,
            commandId,
            threadId: binding.threadId,
            request: {
              type: "provider-runtime.continue" as const,
              sourceRunId: binding.sourceRunId,
            },
          };
          const event = {
            id: yield* input.ids.allocate.event({ threadId: binding.threadId, commandId }),
            type: "run.updated" as const,
            threadId: binding.threadId,
            runId: source.id,
            providerInstanceId: source.providerInstanceId,
            occurredAt: now,
            payload: continuation
              ? { ...source, status: "starting" as const, completedAt: null }
              : {
                  ...source,
                  status: "cancelled" as const,
                  terminationCause: { kind: "server_restart" as const },
                  queuePosition: null,
                  completedAt: now,
                },
          };
          const committed = yield* input.sink.writeIfRunCurrent({
            threadId: binding.threadId,
            runId: source.id,
            activeAttemptId: source.activeAttemptId,
            expectedStatus: source.status,
            commandId,
            events: [event],
            effects: [effect],
          });
          if (!committed.committed)
            return yield* new CodexDetachedAppServerError({
              detail: "The Codex survivor source run changed during recovery.",
            });
          if (
            !(yield* input.outbox.requeueSurvivorContinuation(
              binding.threadId,
              binding.sourceRunId,
            ))
          )
            return yield* new CodexDetachedAppServerError({
              detail: "The Codex survivor continuation is unavailable.",
            });
        }),
      });
    }
  },
);
