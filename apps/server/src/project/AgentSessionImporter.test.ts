import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  bundledMockAgentPath,
  makeMockRuntime,
} from "../orchestration-v2/Adapters/AcpMockRuntime.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { layerScannerTest } from "./AgentSessionScanner.testkit.ts";
import { expect, it } from "@effect/vitest";
import {
  AgentSessionImportSource,
  type AgentSessionSource,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const decodeImport = Schema.decodeUnknownOption(
  Schema.Struct({ importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)) }),
);

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
    worktree: null as { path: string; branch: string | null } | null,
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
  driver = ProviderDriverKind.make(source.source.provider),
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
  fixture?:
    | ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape["get"]
    | { workspaceRoot: string; scanner: AgentSessionScanner.AgentSessionScanner["Service"] },
) {
  const [getAdapter, realScan] =
    typeof fixture === "function" ? [fixture, undefined] : [undefined, fixture];
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)(
            getAdapter ? { get: getAdapter } : {},
          ),
          ThreadCommandExecutor.layer,
          sinkLayer,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          realScan === undefined
            ? Layer.mock(AgentSessionScanner.AgentSessionScanner)({
                recentThreads: () => Stream.fromIterable(candidates),
              })
            : Layer.succeed(AgentSessionScanner.AgentSessionScanner, realScan.scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: realScan?.workspaceRoot ?? "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return {
    run: importer.importRecentAgentThreads({ projectId, includePi: true }),
    published,
    importer,
  };
});

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      unowned.thread.omittedMessageCount = 1;
      unowned.worktree = { path: "/workspace/project/.claude/worktrees/feat", branch: "feat" };
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter([
        active,
        archived,
        deleted,
        ownedPi,
        otherInstance,
        unowned,
        unownedPi,
      ]);

      expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned), importId(unownedPi)]));
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        const notices = records.turnItems.filter((item) => item.type === "system_notice");
        if (source === unowned) {
          expect(records.turnItems[0]).toBe(notices[0]);
          expect(notices).toMatchObject([
            {
              ordinal: 1,
              runId: null,
              message: expect.stringContaining("1 earlier message was not imported"),
            },
          ]);
        } else {
          expect(notices).toEqual([]);
        }
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.worktreePath).toBe(source.worktree?.path ?? null);
        expect(records.thread.branch).toBe(source.worktree?.branch ?? null);
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: {
            cwd: source.worktree?.path ?? "/workspace/project",
            importedTranscripts: [source.source],
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toMatchObject({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toMatchObject({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("counts only new threads when re-importing cached and recovered transcripts", () =>
  Effect.gen(function* () {
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const cached = candidate(
      CLAUDE_MODEL_SELECTION,
      "020e7f00-dce6-406b-8ec6-ed90498945d6",
      "claudeAgent",
    );
    const recovered = candidate(CODEX_MODEL_SELECTION, "recovered");
    recovered.thread.messages = recovered.thread.messages.map((message) =>
      message.role === "assistant"
        ? { ...message, createdAt: "2026-09-01T09:59:00.000Z" }
        : message,
    );
    const initial = yield* makeImporter([cached, recovered]);
    expect(yield* initial.run).toEqual({ importedCount: 2, skippedCount: 0 });
    const before = yield* events.read({ threadId: importId(recovered) }).pipe(Stream.runCollect);
    // The file changed on disk but still holds the imported messages.
    recovered.source.size += 100;
    recovered.source.mtimeMs += 1;
    const duplicate = { ...recovered.source, filePath: "/tmp/duplicate.jsonl" };
    const fresh = candidate(CODEX_MODEL_SELECTION, "fresh");
    const repeated = yield* makeImporter([
      { _tag: "AlreadyImported", source: cached.source },
      recovered,
      { _tag: "Duplicate", source: duplicate, messages: recovered.thread.messages },
      {
        _tag: "Duplicate",
        source: { ...duplicate, filePath: "/tmp/different.jsonl" },
        messages: recovered.thread.messages.map((message) => ({
          ...message,
          text: message.text + " ",
        })),
      },
      fresh,
      { _tag: "Skipped", thread: "missing-parent", reason: "Parent history is unavailable." },
    ]);

    expect(yield* repeated.run).toEqual({
      importedCount: 1,
      skippedCount: 1,
      skippedThreads: [{ thread: "missing-parent", reason: "Parent history is unavailable." }],
    });
    expect(yield* events.read({ threadId: importId(recovered) }).pipe(Stream.runCollect)).toEqual(
      before,
    );
    expect(
      new Set(
        repeated.published.flatMap((stored) => ("event" in stored ? [stored.event.threadId] : [])),
      ),
    ).toEqual(new Set([importId(fresh)]));
    const row = Option.getOrThrow(yield* runtimes.getByThreadId({ threadId: importId(recovered) }));
    expect(Option.getOrThrow(decodeImport(row.runtimePayload)).importedTranscripts).toEqual([
      recovered.source,
      duplicate,
    ]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("bounds skipped detail count and strings while counting every skip", () =>
  Effect.gen(function* () {
    const importer = yield* makeImporter(
      Array.from({ length: 25 }, () => ({
        _tag: "Skipped" as const,
        thread: "t".repeat(500),
        reason: "r".repeat(500),
      })),
    );
    const result = yield* importer.run;
    expect(result.skippedCount).toBe(25);
    expect(result.skippedThreads).toHaveLength(20);
    expect(
      result.skippedThreads?.every(
        ({ thread, reason }) => thread.length <= 100 && reason.length <= 200,
      ),
    ).toBe(true);
    expect(result).toMatchObject({ skippedDetailsOmitted: 5 });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("certifies continued native history after a partial import retry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const original = candidate(CODEX_MODEL_SELECTION, "partial-retry");
    const threadId = importId(original);
    const importer = yield* makeImporter([original]);
    yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
    expect(yield* importer.run).toMatchObject({ importedCount: 0, skippedCount: 1 });
    yield* sql`DROP TRIGGER fail_runtime`;
    expect(yield* runtimes.list()).toEqual([]);
    const continued = candidate(CODEX_MODEL_SELECTION, original.source.providerSessionId);
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue outside GOAT", createdAt: timestamp },
      { role: "assistant", text: "Native continuation", createdAt: timestamp },
    );
    expect(yield* (yield* makeImporter([continued])).run).toMatchObject({
      importedCount: 0,
      skippedCount: 0,
    });
    expect(
      (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Fix it", "Fixed", "Continue outside GOAT", "Native continuation"]);
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
      runtimePayload: { importedTranscripts: [continued.source] },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("does not record a changed transcript as imported without its new messages", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const first = candidate(
      CLAUDE_MODEL_SELECTION,
      "6f1c2a7e-3b4d-4e5f-9a8b-1c2d3e4f5a6b",
      "claudeAgent",
    );
    const threadId = importId(first);
    expect(yield* (yield* makeImporter([first])).run).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    const continued = candidate(
      CLAUDE_MODEL_SELECTION,
      first.source.providerSessionId,
      "claudeAgent",
    );
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue", createdAt: timestamp },
      { role: "assistant", text: "Continued", createdAt: timestamp },
    );
    yield* (yield* makeImporter([continued])).run;

    const recorded = decodeImport(
      Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimePayload,
    ).pipe(Option.getOrThrow).importedTranscripts;
    const texts = (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
      (message) => message.text,
    );
    expect({
      recordsChangedTranscript: recorded?.some((source) => source.size === 200) ?? false,
      showsNewMessages: texts.includes("Continued"),
    }).not.toEqual({ recordsChangedTranscript: true, showsNewMessages: false });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("repeated imports reach linked-worktree sessions behind the scan budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-import-worktree-budget-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature");
    yield* fs.makeDirectory(worktreeGitDir, { recursive: true });
    yield* fs.makeDirectory(worktree);
    yield* fs.writeFileString(path.join(repo, ".git", "config"), "[core]\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    const sessions = path.join(codexHome, "sessions", "2026", "09", "01");
    yield* fs.makeDirectory(sessions, { recursive: true });
    const nowMs = DateTime.toEpochMillis(now);
    yield* TestClock.setTime(nowMs);
    // One more session than the 100-transcript scan budget, all run in the linked worktree.
    for (let index = 0; index < 101; index++) {
      const file = path.join(sessions, `rollout-${String(index).padStart(3, "0")}.jsonl`);
      const records = [
        { type: "session_meta", payload: { id: `session-${index}`, cwd: worktree } },
        { type: "event_msg", payload: { type: "user_message", message: `Request ${index}` } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        },
      ];
      yield* fs.writeFileString(
        file,
        records.map((record) => JSON.stringify(record) + "\n").join(""),
      );
      const modifiedAtSeconds = nowMs / 1000 - (index + 1);
      yield* fs.utimes(file, modifiedAtSeconds, modifiedAtSeconds);
    }

    const scannerContext = yield* Layer.build(
      layerScannerTest({ claudeHomePath: claudeHome, codexHomePath: codexHome }),
    );
    const importer = yield* makeImporter([], Effect.void, {
      workspaceRoot: repo,
      scanner: Context.get(scannerContext, AgentSessionScanner.AgentSessionScanner),
    });

    expect(yield* importer.run).toMatchObject({ importedCount: 100, skippedCount: 1 });
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    const oldest = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        projections.getThread(ThreadId.make("import:codex:session-100")),
      ),
    );
    expect(oldest.worktreePath).toBe(worktree);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);
it.effect("tolerates a missing transcript owner but propagates failed ownership reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ownership-read");
    const threadId = importId(source);
    yield* runtimes.upsert({
      threadId: ThreadId.make("missing-owner"),
      providerName: "codex",
      providerInstanceId: source.source.providerInstanceId,
      adapterKey: "codex",
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: timestamp,
      resumeCursor: null,
      runtimePayload: { importedTranscripts: [source.source] },
    });
    yield* runtimes.recordImportedTranscript({
      threadId: ThreadId.make("missing-owner"),
      source: source.source,
    });
    const importer = yield* makeImporter([source]);
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });

    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${threadId}`;
    expect(yield* Effect.flip(importer.run)).toMatchObject({
      _tag: "AgentSessionScanError",
      operation: "read-projects",
      cause: {
        _tag: "OrchestratorProjectionError",
        threadId,
        cause: { _tag: "ProjectionStoreReadError" },
      },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("imports ACP text and reasoning once after a failed history read", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const source = candidate(
      { instanceId: ProviderInstanceId.make("acp-fixture"), model: "default" },
      "native-history",
    );
    const threadId = yield* seedOwner(source, "active", ProviderDriverKind.make("acpRegistry"));
    let failed = false;
    const thoughtId = MessageId.make("thought");
    const adapter = {
      openSession: () =>
        Effect.succeed({
          readThreadSnapshot: ({
            providerThread,
          }: {
            providerThread: OrchestrationV2ProviderThread;
          }) =>
            Effect.suspend(() => {
              if (!failed) {
                failed = true;
                return Effect.fail(
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: ProviderDriverKind.make("acpRegistry"),
                    providerThreadId: providerThread.id,
                    cause: "native read failed",
                  }),
                );
              }
              return Effect.succeed({
                providerThread,
                providerTurns: [],
                runtimeRequests: [],
                reasoningMessageIds: [thoughtId],
                messages: [
                  {
                    id: MessageId.make("prompt"),
                    role: "user",
                    text: "Earlier question",
                    createdAt: now,
                  },
                  { id: thoughtId, role: "assistant", text: "Earlier reasoning", createdAt: now },
                  {
                    id: MessageId.make("answer"),
                    role: "assistant",
                    text: "Earlier answer",
                    createdAt: now,
                  },
                ],
              });
            }),
        }),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
    const { importer } = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
    const read = importer.importNativeHistory({
      threadId,
      projectId,
      workspaceRoot: "/workspace/project",
    });
    expect((yield* Effect.flip(read))._tag).toBe("ProviderAdapterReadThreadSnapshotError");
    expect((yield* projections.getThreadRecords(threadId, ["messages"])).messages).toEqual([]);
    expect(yield* read).toBe(true);
    expect(yield* read).toBe(false);

    const stored = yield* projections.getThreadRecords(threadId, ["messages", "runs"]);
    expect(stored.thread.historyOrigin).toBe("v1_import");
    expect(stored.runs).toEqual([]);
    expect(stored.messages.map((message) => message.text)).toEqual([
      "Earlier question",
      "Earlier answer",
    ]);
    const page = yield* projections.getTimelinePage(threadId, { view: "activity", limit: 10 });
    expect(page.items).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          type: "reasoning",
          text: "Earlier reasoning",
          runId: null,
        }),
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

const acpImportHost = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const acpImportTest = Layer.mergeAll(
  persistence,
  acpImportHost,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(acpImportHost)),
);

it.effect("keeps ACP history pending after replay pauses without a load response", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const instanceId = ProviderInstanceId.make("acp-held-history");
    const driver = ProviderDriverKind.make("acpRegistry");
    const source = candidate({ instanceId, model: "default" }, "mock-session-1");
    const threadId = yield* seedOwner(source, "active", driver);
    const replayedFragment = yield* Deferred.make<void>();
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: {
        driver,
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: makeMockRuntime({
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          mockAgentPath: yield* bundledMockAgentPath,
          environment: (attempt): Readonly<Record<string, string>> =>
            attempt === 1
              ? {
                  GOAT_ACP_HANG_LOAD_SESSION_AFTER_REPLAY: "1",
                  GOAT_ACP_LOAD_SESSION_DELAY_MS: "3600000",
                }
              : {},
          wrapRuntime: (runtime) => ({
            ...runtime,
            handleSessionUpdate: (handler) =>
              runtime.handleSessionUpdate((notification) => {
                const { update } = notification;
                return handler(notification).pipe(
                  Effect.tap(() =>
                    update.sessionUpdate === "user_message_chunk" &&
                    update.content.type === "text" &&
                    update.content.text === "replay-tail"
                      ? Deferred.succeed(replayedFragment, undefined)
                      : Effect.void,
                  ),
                );
              }),
          }),
        }),
      },
    });
    const { importer } = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
    const importHistory = importer.importNativeHistory({
      threadId,
      projectId,
      workspaceRoot: process.cwd(),
    });
    const read = yield* importHistory.pipe(Effect.result, Effect.forkScoped);
    const stored = projections.getThreadRecords(threadId, ["messages"]);
    yield* Deferred.await(replayedFragment);
    yield* TestClock.adjust("3 seconds");
    expect((yield* stored).messages).toEqual([]);
    yield* TestClock.adjust("90 seconds");
    const result = yield* Fiber.join(read);
    const records = yield* stored;
    expect(records.thread.historyOrigin).not.toBe("v1_import");
    expect(records.messages).toEqual([]);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ProviderAdapterOpenSessionError",
        cause: {
          method: "session/load",
          detail: "session/load timed out waiting for RPC response",
        },
      },
    });

    expect(yield* importHistory).toBe(true);
    const repaired = yield* stored;
    expect(repaired.thread.historyOrigin).toBe("v1_import");
    expect(repaired.messages.map(({ text }) => text)).toEqual(["replay"]);
  }).pipe(Effect.scoped, Effect.provide(acpImportTest)),
);
