import * as SqlClient from "effect/sql/SqlClient";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import {
  CommandId,
  RunId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import {
  continuationCrashCount,
  priorContinuationCrashCount,
} from "./goat/ContinuationCrashBudget.ts";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import * as Schema from "effect/Schema";
import { OrchestrationEffectRequestV2 } from "./EffectOutboxRequest.ts";
import { OrchestrationEffectRequestV2 as BaseRequest } from "./EffectOutboxRequest.base.testkit.ts";

const decodeRequest = Schema.decodeUnknownSync(OrchestrationEffectRequestV2);
const decodeBaseRequest = Schema.decodeUnknownSync(BaseRequest);

it("preserves a continuation crash budget while older records and readers remain compatible", () => {
  const old = { type: "provider-runtime.continue", sourceRunId: "run:old" };
  const current = { ...old, processLossCount: 2 };
  expect(decodeRequest(old)).toMatchObject(old);
  expect(decodeBaseRequest(current)).toMatchObject(old);
  expect(decodeRequest(current)).toMatchObject(current);
  expect(() => decodeRequest({ ...old, processLossCount: -1 })).toThrow();
});

it.effect("stops automatic continuation at the persisted crash budget and makes it visible", () =>
  Effect.gen(function* () {
    const base = makeLocalCommandHarness({ text: "Original request" }).projection();
    const source = {
      ...base.runs[0]!,
      status: "cancelled" as const,
      completedAt: base.runs[0]!.requestedAt,
    };
    const projection = {
      ...base,
      thread: {
        ...base.thread,
        providerInstanceId: source.providerInstanceId,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        snoozedUntil: null,
        lineage: { relationshipToParent: null, parentThreadId: null },
        forkedFrom: null,
      },
      runs: [source],
      providerTurns: [],
    };
    const commands: Array<{ type: string; message?: string }> = [];
    yield* continueRestartedRun({
      threadId: base.thread.id,
      sourceRunId: source.id,
      processLossCount: 3,
    } as Parameters<typeof continueRestartedRun>[0]).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection as never),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    expect(commands.some((command) => command.type === "message.dispatch")).toBe(false);
    expect(
      commands.some(
        (command) => command.type === "thread.notice.record" && command.message?.includes("retry"),
      ),
    ).toBe(true);
  }),
);

it.effect("a second crash carries the preceding persisted recovery budget", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Original" });
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sourceId = RunId.make("first-crash-run");
    yield* outbox.enqueue([
      {
        id: `effect:restart-continuation:${sourceId}`,
        commandId: CommandId.make("command:crash-1"),
        threadId: harness.threadId,
        request: { type: "provider-runtime.continue", sourceRunId: sourceId, processLossCount: 1 },
      },
    ]);
    const run = { ...harness.projection().runs[0]!, restartContinuationOfRunId: sourceId };
    expect(yield* continuationCrashCount(outbox, run)).toBe(2);
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

const threadId = ThreadId.make("thread:restart");
const runId = RunId.make("run:restart");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart");
const sessionId = ProviderSessionId.make("session:restart");
const attemptId = RunAttemptId.make("attempt:restart");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restart-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

it.effect("startup persists the first crash count on a continuation intent", () =>
  Effect.gen(function* () {
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(makeProjection()),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    expect(committed?.effects[0]?.request).toMatchObject({
      type: "provider-runtime.continue",
      sourceRunId: runId,
      processLossCount: 1,
    });
  }),
);

it.effect.each(["queued", "waiting"] as const)(
  "retains a %s continuation's crash budget until the run settles",
  (status) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const current = yield* DateTime.now;
      const old = DateTime.formatIso(DateTime.subtractDuration(current, Duration.days(8)));
      const timestamp = DateTime.formatIso(current);
      yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at, completed_at) VALUES ('effect:retained-recovery', 'command:retained-recovery', 'thread:retained-recovery', 'provider-runtime.continue', '{"type":"provider-runtime.continue","sourceRunId":"run:retained-source","processLossCount":2}', 'succeeded', ${old}, ${old}, ${old}, ${old})`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run:retained-recovery', 'thread:retained-recovery', 1, 'codex', ${status}, ${timestamp}, '{"restartContinuationOfRunId":"run:retained-source"}')`;
      expect(yield* outbox.pruneSettled).toBe(0);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run:retained-recovery'`;
      expect(yield* outbox.pruneSettled).toBe(1);
    }).pipe(
      Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect("startup increments the crash count for a second consecutive crash", () =>
  Effect.gen(function* () {
    const priorId = RunId.make("prior-crash-run");
    const base = makeProjection();
    const projection = {
      ...base,
      runs: [
        { ...base.runs[0]!, status: "starting" as const, restartContinuationOfRunId: priorId },
      ],
      providerTurns: [],
    };
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            getMessagesById: () => Effect.succeed(new Map()),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            get: () =>
              Effect.succeedSome({
                request: {
                  type: "provider-runtime.continue",
                  sourceRunId: priorId,
                  processLossCount: 1,
                },
              } as never),
            listNeverAttemptedStarts: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    expect(committed?.effects[0]?.request).toMatchObject({
      type: "provider-runtime.continue",
      sourceRunId: runId,
      processLossCount: 2,
    });
  }),
);

it.effect("a planned continuation leaves no crash count to carry forward", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Original" });
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sourceId = RunId.make("planned-source");
    yield* outbox.enqueue([
      {
        id: `effect:restart-continuation:${sourceId}`,
        commandId: CommandId.make("command:planned"),
        threadId: harness.threadId,
        request: { type: "provider-runtime.continue", sourceRunId: sourceId },
      },
    ]);
    const run = { ...harness.projection().runs[0]!, restartContinuationOfRunId: sourceId };
    expect(yield* priorContinuationCrashCount(outbox, run)).toBeUndefined();
    expect(yield* continuationCrashCount(outbox, run)).toBe(1);
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

it.effect("a planned restart resets an earlier crash chain without adding a wire field", () =>
  Effect.gen(function* () {
    const base = makeLocalCommandHarness({ text: "Original request" }).projection();
    const seed = base.runs[0]!;
    const runs = Array.from({ length: 4 }, (_, index) => ({
      ...seed,
      id: RunId.make(`planned-chain:${index}`),
      ordinal: index + 1,
      status: "cancelled" as const,
      completedAt: seed.requestedAt,
      ...(index === 0
        ? {}
        : { restartContinuationOfRunId: RunId.make(`planned-chain:${index - 1}`) }),
    }));
    const source = runs[3]!;
    const projection = {
      ...base,
      thread: {
        ...base.thread,
        providerInstanceId: source.providerInstanceId,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        snoozedUntil: null,
        lineage: { relationshipToParent: null, parentThreadId: null },
        forkedFrom: null,
      },
      runs,
      providerTurns: [],
    };
    const commands: string[] = [];
    yield* continueRestartedRun({
      threadId: base.thread.id,
      sourceRunId: source.id,
      plannedRestart: true,
    } as Parameters<typeof continueRestartedRun>[0]).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection as never),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command.type);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    expect(commands).toContain("message.dispatch");
  }),
);

it.effect("a retry of a planned continuation retains the reset", () =>
  Effect.gen(function* () {
    const base = makeLocalCommandHarness({ text: "Original request" }).projection();
    const seed = base.runs[0]!;
    const runs = Array.from({ length: 4 }, (_, index) => ({
      ...seed,
      id: RunId.make(`planned-retry:${index}`),
      ordinal: index + 1,
      status: "cancelled" as const,
      completedAt: seed.requestedAt,
      ...(index === 0
        ? {}
        : { restartContinuationOfRunId: RunId.make(`planned-retry:${index - 1}`) }),
    }));
    const source = runs[3]!;
    const projection = {
      ...base,
      thread: {
        ...base.thread,
        providerInstanceId: source.providerInstanceId,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        snoozedUntil: null,
        lineage: { relationshipToParent: null, parentThreadId: null },
        forkedFrom: null,
      },
      runs,
      providerTurns: [],
    };
    const commands: string[] = [];
    const outbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      get: () =>
        Effect.succeedSome({
          commandId: CommandId.make("command:restart-prepare:source"),
          request: { type: "provider-runtime.continue", sourceRunId: runs[2]!.id },
        } as never),
    });
    yield* continueRestartedRun({ threadId: base.thread.id, sourceRunId: source.id }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection as never),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command.type);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          outbox,
        ),
      ),
    );
    expect(commands).toContain("message.dispatch");
  }),
);
