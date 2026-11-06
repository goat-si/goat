// @effect-diagnostics-next-line nodeBuiltinImport:off -- hash the unchanged fixture with Node crypto.
import * as NodeCrypto from "node:crypto";
import { seedV1Database } from "./LegacyV1Cutover.fixture.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const ACTIVE_THREAD = "thread:cutover:active";
const ARCHIVED_THREAD = "thread:cutover:archived";
const PINNED_THREAD = "thread:cutover:pinned";
const SNOOZED_THREAD = "thread:cutover:snoozed";
const DELETED_THREAD = "thread:cutover:deleted";
const INTERRUPTED_THREAD = "thread:cutover:interrupted";
const LONG_THREAD = "thread:cutover:long";
const ALL_THREADS = [
  ACTIVE_THREAD,
  ARCHIVED_THREAD,
  PINNED_THREAD,
  SNOOZED_THREAD,
  DELETED_THREAD,
  INTERRUPTED_THREAD,
  LONG_THREAD,
] as const;

const EARLIEST_MARKER = "EARLIEST_IMPORT_MARKER";
const LATEST_MARKER = "LATEST_IMPORT_MARKER";
const CONTINUATION_PROMPT = "Continue the migrated thread.";
const CONTINUATION_RESPONSE = "codex continuation response";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const codexModelSelection = {
  instanceId,
  model: "gpt-5.4",
};

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
}

const unimplemented = (detail: string) =>
  Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));

const makeCodexAdapter = (capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: codexModelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(capturedTurns, (turns) => [
                ...turns,
                {
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              yield* PubSub.publishAll(events, [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: CONTINUATION_RESPONSE,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in cutover test"),
          rollbackThread: () => unimplemented("rollbackThread unused in cutover test"),
          forkThread: () => unimplemented("forkThread unused in cutover test"),
        };
      }),
  }) satisfies ProviderAdapter.ProviderAdapterV2["Service"];

// Await the dispatched run's terminal event on the persisted domain-event stream
// instead of polling the projection, then drain remaining outbox effects.
const dispatchMessageAwaitingRun = Effect.fn("LegacyV1Cutover.dispatchMessageAwaitingRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly commandId: string;
    readonly text: string;
  }) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const messageId = MessageId.make(input.messageId);
    // Capture the cursor before dispatch so even a late subscriber replays
    // the terminal event instead of starting its live tail after completion.
    const afterSequence = yield* eventSink.latestSequence();
    const terminal = eventSink.stream({ afterSequence }).pipe(
      Stream.map((stored) => stored.event),
      Stream.filter((event) => event.type === "run.updated"),
      Stream.filter(
        (event) =>
          ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
            event.payload.status,
          ) &&
          event.payload.threadId === input.threadId &&
          event.payload.userMessageId === messageId,
      ),
      Stream.take(1),
      Stream.runForEach((event) =>
        Effect.sync(() =>
          assert.equal(event.payload.status, "completed", `Run for ${messageId} did not complete`),
        ),
      ),
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(input.commandId),
      threadId: input.threadId,
      messageId,
      text: input.text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    yield* worker.drain();
    yield* terminal;
    yield* worker.drain();
    return yield* orchestrator.getThreadProjection(input.threadId);
  },
);

const layerBoot = (input: {
  readonly name: string;
  readonly dbPath: string;
  readonly workspace: string;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
}) => {
  const layerDatabase = SqlitePersistence.layerFromPath(input.dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
  const layerProjectionStoreProvided = ProjectionStore.layer.pipe(
    Layer.provideMerge(layerDatabase),
  );
  const layerStoresProvided = Layer.mergeAll(
    layerDatabase,
    layerEventStoreProvided,
    layerProjectionStoreProvided,
  );
  const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
  const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
    Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
  );
  const layerMaintenanceProvided = ProjectionMaintenance.layer.pipe(
    Layer.provide(layerStoresProvided),
  );
  const layerOrchestratorProvided = ProviderReplayHarness.layerWithRegistry(
    {
      name: input.name,
      runtimePolicyOverride: {
        cwd: input.workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    },
    ProviderAdapterRegistry.layerSingle(makeCodexAdapter(input.capturedTurns)),
    { databaseLayer: layerDatabase },
  );
  return Layer.mergeAll(
    layerStoresProvided,
    layerEventSinkProvided,
    layerImporterProvided,
    layerMaintenanceProvided,
    layerOrchestratorProvided,
  );
};

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const makeCapturingLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const sha256File = Effect.fn("LegacyV1Cutover.sha256File")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return NodeCrypto.createHash("sha256")
    .update(yield* fs.readFile(filePath))
    .digest("hex");
});

interface LegacyTableSnapshot {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

// Migrations legitimately append columns; preservation means the columns the
// v1 schema already had keep their exact values.
const restrictToSnapshotColumns = (
  rows: ReadonlyArray<Record<string, unknown>>,
  snapshot: LegacyTableSnapshot,
) => rows.map((row) => Object.fromEntries(snapshot.columns.map((column) => [column, row[column]])));

const messageOrdinals = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems
    .filter(
      (
        item,
      ): item is Extract<typeof item, { readonly type: "user_message" | "assistant_message" }> =>
        item.type === "user_message" || item.type === "assistant_message",
    )
    .map((item) => [String(item.messageId), item.ordinal, item.status] as const);

describe("orchestration v2 legacy v1 cutover", () => {
  it.live(
    "migrates an untouched v1 database copy through shell import, lazy transcripts, continuation and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspace = yield* checkpointWorkspace("legacy-v1-cutover");
          const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-v1-cutover-state-" });
          const fixturePath = path.join(stateDir, "v1-source.sqlite");
          const copyPath = path.join(stateDir, "userdata", "state.sqlite");
          yield* fs.makeDirectory(path.join(stateDir, "userdata"), { recursive: true });

          const v1Snapshot = yield* seedV1Database(fixturePath, workspace);
          const fixtureHashBefore = yield* sha256File(fixturePath);
          yield* fs.copyFile(fixturePath, copyPath);

          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const longThreadId = ThreadId.make(LONG_THREAD);

          const boot1Logs: CapturedLog[] = [];
          const firstBoot = yield* Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
              const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
              const projections = yield* ProjectionStore.ProjectionStoreV2;
              assert.equal(yield* importer.pendingThreadCount, ALL_THREADS.length);
              const shellImport = yield* importer.reconcileShells;
              assert.deepStrictEqual(shellImport, {
                importedThreadCount: ALL_THREADS.length,
                importedMessageCount: 14,
              });

              assert.deepStrictEqual(yield* importer.reconcileShells, {
                importedThreadCount: 0,
                importedMessageCount: 0,
              });
              assert.isTrue((yield* maintenance.rebuild).valid);

              const shellSnapshot = yield* projections.getShellSnapshot();
              const visibleShellIds = [
                ...shellSnapshot.threads.map((thread) => thread.id),
                ...shellSnapshot.archivedThreads.map((thread) => thread.id),
              ];
              assert.notInclude(visibleShellIds, ThreadId.make(DELETED_THREAD));
              assert.include(
                shellSnapshot.archivedThreads.map((thread) => thread.id),
                ThreadId.make(ARCHIVED_THREAD),
              );
              const pinnedShell = shellSnapshot.threads.find(
                (thread) => thread.id === PINNED_THREAD,
              );
              assert.equal(pinnedShell?.pinOrderKey, "a0");

              const activeShell = yield* projections.getThreadProjection(
                ThreadId.make(ACTIVE_THREAD),
              );
              assert.equal(activeShell.thread.historyOrigin, "v1_import");
              assert.isNull(activeShell.thread.activeProviderThreadId);
              assert.deepStrictEqual(
                activeShell.messages.map((message) => message.id),
                ["message:cutover:active:3", "message:cutover:active:4"],
              );
              assert.isEmpty(activeShell.providerThreads);

              assert.isEmpty(
                activeShell.turnItems.filter(
                  (item) => item.type !== "user_message" && item.type !== "assistant_message",
                ),
              );

              const deletedShell = yield* projections.getThreadProjection(
                ThreadId.make(DELETED_THREAD),
              );
              assert.isNotNull(deletedShell.thread.deletedAt);
              assert.equal(
                deletedShell.thread.deletedAt?.toString(),
                DateTime.makeUnsafe("2026-01-09T00:00:00.000Z").toString(),
              );

              for (const threadId of [
                ACTIVE_THREAD,
                ARCHIVED_THREAD,
                PINNED_THREAD,
                DELETED_THREAD,
                INTERRUPTED_THREAD,
                LONG_THREAD,
              ]) {
                yield* importer.ensureTranscript(ThreadId.make(threadId));
              }
              assert.deepStrictEqual(
                yield* importer.ensureTranscript(ThreadId.make(ACTIVE_THREAD)),
                { importedThreadCount: 0, importedMessageCount: 0 },
              );

              const active = yield* projections.getThreadProjection(ThreadId.make(ACTIVE_THREAD));
              assert.deepStrictEqual(
                active.messages.map((message) => message.id),
                [
                  "message:cutover:active:1",
                  "message:cutover:active:2",
                  "message:cutover:active:3",
                  "message:cutover:active:4",
                ],
              );
              assert.deepStrictEqual(messageOrdinals(active), [
                ["message:cutover:active:1", 1, "completed"],
                ["message:cutover:active:2", 2, "completed"],
                ["message:cutover:active:3", 3, "completed"],
                ["message:cutover:active:4", 4, "completed"],
              ]);
              assert.deepStrictEqual(
                active.messages.find((message) => message.id === "message:cutover:active:2")
                  ?.attachments,
                [
                  {
                    type: "image",
                    id: "att-1",
                    name: "shot.png",
                    mimeType: "image/png",
                    sizeBytes: 1234,
                  },
                ],
              );
              assert.equal(active.thread.linkedPullRequest?.number, 9100);
              assert.deepStrictEqual(
                active.thread.pullRequests?.map((pullRequest) => pullRequest.number),
                [9100],
              );

              const archived = yield* projections.getThreadProjection(
                ThreadId.make(ARCHIVED_THREAD),
              );
              assert.isNotNull(archived.thread.archivedAt);
              const pinned = yield* projections.getThreadProjection(ThreadId.make(PINNED_THREAD));
              assert.isNotNull(pinned.thread.pinnedAt);
              assert.equal(pinned.thread.pinOrderKey, "a0");
              const snoozed = yield* projections.getThreadProjection(ThreadId.make(SNOOZED_THREAD));
              assert.equal(
                snoozed.thread.snoozedUntil?.toString(),
                DateTime.makeUnsafe("2026-02-01T00:00:00.000Z").toString(),
              );

              assert.deepStrictEqual(
                snoozed.messages.map((message) => message.id),
                ["message:cutover:snoozed:1", "message:cutover:snoozed:3"],
              );
              const snoozedImportRow = yield* sql<{
                readonly transcript_imported_at: string | null;
              }>`
              SELECT transcript_imported_at
              FROM orchestration_v2_legacy_imports
              WHERE thread_id = ${SNOOZED_THREAD}
            `;
              assert.isNull(snoozedImportRow[0]?.transcript_imported_at);

              // A failed hydration leaves the legacy rows and pending marker
              // available for retry in a fresh runtime after restart.
              yield* sql`
                CREATE TRIGGER fail_snoozed_hydration
                BEFORE INSERT ON orchestration_events
                WHEN NEW.event_id = 'migration:v1:message:message:cutover:snoozed:2'
                BEGIN
                  SELECT RAISE(ABORT, 'injected cutover hydration failure');
                END
              `;
              const hydrationError = yield* importer
                .ensureTranscript(ThreadId.make(SNOOZED_THREAD))
                .pipe(Effect.flip);
              assert.equal(hydrationError._tag, "LegacyV1ThreadImportError");
              assert.equal(yield* importer.pendingThreadCount, 1);

              const interrupted = yield* projections.getThreadProjection(
                ThreadId.make(INTERRUPTED_THREAD),
              );
              assert.deepStrictEqual(messageOrdinals(interrupted), [
                ["message:cutover:interrupted:1", 1, "completed"],
                ["message:cutover:interrupted:2", 2, "interrupted"],
              ]);

              const continued = yield* dispatchMessageAwaitingRun({
                threadId: longThreadId,
                messageId: "message:cutover:long:continuation",
                commandId: "command:cutover:continue",
                text: CONTINUATION_PROMPT,
              });

              const runs = continued.runs.filter((run) => run.ordinal >= 1);
              assert.equal(runs.at(-1)?.status, "completed");
              assert.equal(continued.providerThreads.length, 1);
              assert.isNotNull(continued.providerThreads[0]?.nativeThreadRef);
              assert.equal(continued.contextHandoffs.length, 1);
              const handoff = continued.contextHandoffs[0]!;
              assert.equal(handoff.strategy, "manual_context");
              assert.isAtMost(handoff.summaryText.length, 32_000);
              assert.include(handoff.summaryText, LATEST_MARKER);
              assert.notInclude(handoff.summaryText, EARLIEST_MARKER);
              const turns = yield* Ref.get(capturedTurns);
              assert.equal(turns.length, 1);
              assert.include(turns[0]!.text, "Context handoff (manual_context):");
              assert.include(turns[0]!.text, `User message:\n${CONTINUATION_PROMPT}`);

              const continuedAgain = yield* dispatchMessageAwaitingRun({
                threadId: longThreadId,
                messageId: "message:cutover:long:continuation:2",
                commandId: "command:cutover:continue:again",
                text: "One more.",
              });
              assert.equal(continuedAgain.contextHandoffs.length, 1);
              assert.equal((yield* Ref.get(capturedTurns)).length, 2);

              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              yield* worker.drain();

              const migrationEventCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM orchestration_events
              WHERE application_event_version = 2
                AND event_id LIKE 'migration:v1:%'
            `;
              const importRows = yield* sql<{
                readonly thread_id: string;
                readonly transcript_imported_at: string | null;
              }>`
              SELECT thread_id, transcript_imported_at
              FROM orchestration_v2_legacy_imports
              ORDER BY thread_id
            `;
              const legacyProjects = yield* sql<Record<string, unknown>>`
              SELECT * FROM projection_projects ORDER BY project_id
            `;
              const legacyThreads = yield* sql<Record<string, unknown>>`
              SELECT * FROM projection_threads ORDER BY thread_id
            `;
              const legacyMessages = yield* sql<Record<string, unknown>>`
              SELECT * FROM projection_thread_messages ORDER BY message_id
            `;
              const recordedMigration41 = yield* sql<{ readonly name: string }>`
              SELECT name FROM effect_sql_migrations WHERE migration_id = 41
            `;
              const authSessionColumns = yield* sql<{ readonly name: string }>`
              PRAGMA table_info(auth_sessions)
            `;
              return {
                migrationEventCount: migrationEventCount[0]?.count ?? 0,
                importRows,
                legacyProjects,
                legacyThreads,
                legacyMessages,
                longProjection: continuedAgain,
                migration41Name: recordedMigration41[0]?.name ?? null,
                authSessionColumnNames: authSessionColumns.map((column) => column.name),
              };
            }).pipe(
              Effect.provide(
                layerBoot({
                  name: "legacy-v1-cutover-first",
                  dbPath: copyPath,
                  workspace,
                  capturedTurns,
                }),
              ),
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([makeCapturingLogger(boot1Logs)]),
              ),
            ),
          );

          const divergenceLog = boot1Logs.find((log) =>
            String(log.message).includes("migration history diverges"),
          );
          assert.deepStrictEqual(divergenceLog?.annotations.divergent, [
            "41:ThreadSummaryTimeline (this build: AuthSessionClientConnection)",
          ]);
          assert.equal(firstBoot.migration41Name, "ThreadSummaryTimeline");

          assert.notInclude(firstBoot.authSessionColumnNames, "client_surface");
          assert.notInclude(firstBoot.authSessionColumnNames, "client_app_version");

          // Full row contents of the legacy recovery tables survive migration
          // and continuation unchanged, not just their counts.
          assert.deepStrictEqual(
            restrictToSnapshotColumns(firstBoot.legacyProjects, v1Snapshot.projects),
            v1Snapshot.projects.rows,
          );
          assert.deepStrictEqual(
            restrictToSnapshotColumns(firstBoot.legacyThreads, v1Snapshot.threads),
            v1Snapshot.threads.rows,
          );
          assert.deepStrictEqual(
            restrictToSnapshotColumns(firstBoot.legacyMessages, v1Snapshot.messages),
            v1Snapshot.messages.rows,
          );

          assert.equal(firstBoot.importRows.length, ALL_THREADS.length);
          const unhydratedRows = firstBoot.importRows.filter(
            (row) => row.transcript_imported_at === null,
          );
          assert.deepStrictEqual(
            unhydratedRows.map((row) => row.thread_id),
            [SNOOZED_THREAD],
          );

          const boot2Logs: CapturedLog[] = [];
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
              const projections = yield* ProjectionStore.ProjectionStoreV2;

              assert.equal(yield* importer.pendingThreadCount, 1);
              assert.deepStrictEqual(yield* importer.reconcileShells, {
                importedThreadCount: 0,
                importedMessageCount: 0,
              });
              yield* sql`DROP TRIGGER fail_snoozed_hydration`;
              assert.deepStrictEqual(
                yield* importer.ensureTranscript(ThreadId.make(SNOOZED_THREAD)),
                { importedThreadCount: 1, importedMessageCount: 1 },
              );
              const snoozed = yield* projections.getThreadProjection(ThreadId.make(SNOOZED_THREAD));
              assert.deepStrictEqual(
                snoozed.messages.map((message) => message.id),
                [
                  "message:cutover:snoozed:1",
                  "message:cutover:snoozed:2",
                  "message:cutover:snoozed:3",
                ],
              );
              assert.equal(yield* importer.pendingThreadCount, 0);
              for (const threadId of ALL_THREADS) {
                assert.deepStrictEqual(yield* importer.ensureTranscript(ThreadId.make(threadId)), {
                  importedThreadCount: 0,
                  importedMessageCount: 0,
                });
              }
              const migrationEventCount = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM orchestration_events
              WHERE application_event_version = 2
                AND event_id LIKE 'migration:v1:%'
            `;

              assert.equal(migrationEventCount[0]?.count, firstBoot.migrationEventCount + 2);

              const restarted = yield* projections.getThreadProjection(longThreadId);
              assert.equal(restarted.thread.historyOrigin, "v1_import");
              assert.equal(restarted.contextHandoffs.length, 1);
              assert.isNotNull(restarted.thread.activeProviderThreadId);
              assert.deepStrictEqual(
                restarted.runs.map((run) => run.status),
                firstBoot.longProjection.runs.map((run) => run.status),
              );

              assert.deepStrictEqual(
                restrictToSnapshotColumns(
                  yield* sql<Record<string, unknown>>`
                    SELECT * FROM projection_projects ORDER BY project_id
                  `,
                  v1Snapshot.projects,
                ),
                v1Snapshot.projects.rows,
              );
              assert.deepStrictEqual(
                restrictToSnapshotColumns(
                  yield* sql<Record<string, unknown>>`
                    SELECT * FROM projection_threads ORDER BY thread_id
                  `,
                  v1Snapshot.threads,
                ),
                v1Snapshot.threads.rows,
              );
              assert.deepStrictEqual(
                restrictToSnapshotColumns(
                  yield* sql<Record<string, unknown>>`
                    SELECT * FROM projection_thread_messages ORDER BY message_id
                  `,
                  v1Snapshot.messages,
                ),
                v1Snapshot.messages.rows,
              );
              const quickCheck = yield* sql<{ readonly quick_check: string }>`
              PRAGMA quick_check
            `;
              assert.deepStrictEqual(
                quickCheck.map((row) => row.quick_check),
                ["ok"],
              );
            }).pipe(
              Effect.provide(
                layerBoot({
                  name: "legacy-v1-cutover-restart",
                  dbPath: copyPath,
                  workspace,
                  capturedTurns,
                }),
              ),
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([makeCapturingLogger(boot2Logs)]),
              ),
            ),
          );

          assert.isTrue(
            boot2Logs.some((log) => String(log.message).includes("migration history diverges")),
          );

          // The seeded source file is the untouched recovery copy: migration
          // only ever ran against the file copied out of it.
          assert.equal(yield* sha256File(fixturePath), fixtureHashBefore);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});
