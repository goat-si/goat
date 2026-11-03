// @effect-diagnostics nodeBuiltinImport:off -- process records use an isolated temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import {
  layerTest,
  makeThread,
  threadCreatedEvent,
} from "../orchestration-v2/FoundationPersistence.testkit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeDetachedAppServers } from "./CodexDetachedAppServer.ts";
import { classifyRecovery } from "./CodexSurvivorRecovery.ts";
import * as Survivors from "./CodexSurvivors.ts";

const codex = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");

const seedThread = Effect.fn("CodexRecordSessionsTest.seedThread")(function* (input: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly running: boolean;
  readonly instanceId?: ProviderInstanceId;
}) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const instance = input.instanceId ?? codex;
  const threadId = ThreadId.make(input.threadId);
  const model = { instanceId: instance, model: "gpt-5.4" };
  const sessionId = ProviderSessionId.make(input.sessionId);
  const providerThreadId = ProviderThreadId.make("provider-" + input.threadId);
  const at = (suffix: string) => EventId.make("event:" + input.threadId + ":" + suffix);
  yield* store.apply(
    threadCreatedEvent({
      id: "event:" + input.threadId + ":thread",
      thread: { ...makeThread(threadId, now), providerInstanceId: instance, modelSelection: model },
      now,
    }),
  );
  yield* store.apply({
    id: at("session"),
    type: "provider-session.attached",
    threadId,
    driver,
    providerInstanceId: instance,
    occurredAt: now,
    payload: {
      id: sessionId,
      driver,
      providerInstanceId: instance,
      status: "ready",
      cwd: "/workspace",
      model: model.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  yield* store.apply({
    id: at("provider-thread"),
    type: "provider-thread.updated",
    threadId,
    driver,
    providerInstanceId: instance,
    occurredAt: now,
    payload: {
      id: providerThreadId,
      appThreadId: threadId,
      ownerNodeId: null,
      driver,
      providerInstanceId: instance,
      providerSessionId: sessionId,
      nativeThreadRef: { driver, nativeId: "native-" + input.threadId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      pendingBackgroundTasks: [],
    },
  });
  if (!input.running) return;
  const runId = RunId.make("run-" + input.threadId);
  const attemptId = RunAttemptId.make("attempt-" + input.threadId);
  const turnId = ProviderTurnId.make("turn-" + input.threadId);
  const nodeId = NodeId.make("node-" + input.threadId);
  yield* store.apply({
    id: at("run"),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instance,
      modelSelection: model,
      providerThreadId,
      userMessageId: MessageId.make("message-" + input.threadId),
      rootNodeId: nodeId,
      activeAttemptId: attemptId,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* store.apply({
    id: at("attempt"),
    type: "run-attempt.updated",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: nodeId,
      providerInstanceId: instance,
      providerThreadId,
      providerTurnId: turnId,
      reason: "initial",
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  });
  yield* store.apply({
    id: at("turn"),
    type: "provider-turn.updated",
    threadId,
    runId,
    nodeId,
    occurredAt: now,
    payload: {
      id: turnId,
      providerThreadId,
      nodeId,
      runAttemptId: attemptId,
      nativeTurnRef: { driver, nativeId: "turn-native-" + input.threadId, strength: "strong" },
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  });
});

const record = (name: string, pgid: number, extra: object = {}) => ({
  version: 1,
  name,
  instanceId: "codex",
  socketPath: "/tmp/goat-record-sessions-" + name + ".sock",
  pgid,
  bootId: "boot",
  state: "running",
  createdAt: "2026-01-01T00:00:00Z",
  stderrMode: "discard",
  ...extra,
});

/** Runs startup classification over real records and a real projection store. */
const recover = Effect.fn("CodexRecordSessionsTest.recover")(function* (
  records: ReadonlyArray<ReturnType<typeof record>>,
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-record-sessions-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const dir = NodePath.join(directory, "codex-app-servers");
  yield* Effect.promise(() => NodeFSP.mkdir(dir));
  for (const entry of records)
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(dir, entry.name + ".json"), JSON.stringify(entry)),
    );
  const detached = yield* makeDetachedAppServers({
    stateDir: directory,
    bootId: Effect.succeed("boot"),
    processTable: {
      groupMembers: (pgid) =>
        Effect.succeed(
          records
            .filter((entry) => entry.pgid === pgid)
            .map((entry) => ({ pid: pgid, pgid, argv: entry.socketPath })),
        ),
      ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
    },
    socketAccepts: () => Effect.succeed(false),
    signalGroup: () => Effect.void,
    connect: () =>
      Effect.succeed({ incoming: Stream.never, send: () => Effect.void, closed: Effect.never }),
  });
  const bindings: Survivors.CodexSurvivorBinding[] = [];
  const fenced: string[] = [];
  const survivors = yield* Survivors.CodexSurvivors.pipe(
    Effect.provide(
      Layer.mock(Survivors.CodexSurvivors)({
        classifyRecord: () => Effect.succeed({ type: "verified" as const, pgid: 1, members: [] }),
        classifyExisting: () => Effect.succeed("survivor" as const),
        getStopObligations: () => Effect.succeed([]),
        recordStopObligation: (key, stop) =>
          detached.recordStopObligation(key, stop).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                fenced.push(key.recordName + ":" + stop.threadId);
              }),
            ),
          ),
        blockThread: () => Effect.void,
        replace: (value) =>
          Effect.sync(() => {
            bindings.push(...value);
          }),
      }),
    ),
  );
  const result = yield* classifyRecovery({
    detached: { ...detached, socketTransportEnabled: true },
    survivors,
    projections: yield* ProjectionStore.ProjectionStoreV2,
    outbox: yield* EffectOutbox.EffectOutboxV2,
    sink: yield* EventSink.EventSinkV2,
    ids: yield* IdAllocator.IdAllocatorV2,
    settings: yield* ServerSettings.ServerSettingsService,
  });
  const sessionOf = (name: string) =>
    Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, name + ".json"), "utf8")).pipe(
      Effect.map((text) => (JSON.parse(text) as { providerSessionId?: string }).providerSessionId),
    );
  const boundRecords = Object.fromEntries(
    bindings.map((binding) => [binding.threadId, binding.recordName]),
  );
  return { detached, boundRecords, fenced: fenced.sort(), result, sessionOf };
});

const layer = Layer.mergeAll(
  layerTest,
  ServerSettings.layerTest({ codexTurnsSurviveServerStop: "restart" }),
);

it.effect("startup gives each session's surviving turn its own process and fences neither", () =>
  Effect.gen(function* () {
    yield* seedThread({ threadId: "a", sessionId: "session-a", running: true });
    yield* seedThread({ threadId: "b", sessionId: "session-b", running: true });
    const recovered = yield* recover([
      record("codex-aaaaaaaaaaaa", 1001, { providerSessionId: "session-a" }),
      record("codex-bbbbbbbbbbbb", 1002, { providerSessionId: "session-b" }),
    ]);
    assert.deepEqual(recovered.boundRecords, {
      a: "codex-aaaaaaaaaaaa",
      b: "codex-bbbbbbbbbbbb",
    });
    assert.deepEqual(recovered.fenced, []);
    assert.deepEqual([...recovered.result.blockedThreads], []);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("a record from before the upgrade takes its instance's one running session", () =>
  Effect.gen(function* () {
    yield* seedThread({ threadId: "legacy", sessionId: "session-restarted", running: true });
    const recovered = yield* recover([record("codex-cccccccccccc", 1003)]);
    assert.equal(yield* recovered.sessionOf("codex-cccccccccccc"), "session-restarted");
    assert.deepEqual(recovered.boundRecords, { legacy: "codex-cccccccccccc" });
    assert.deepEqual(recovered.fenced, []);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("a record from before the upgrade beside two running sessions blocks the instance", () =>
  Effect.gen(function* () {
    yield* seedThread({ threadId: "one", sessionId: "session-one", running: true });
    yield* seedThread({ threadId: "two", sessionId: "session-two", running: true });
    const recovered = yield* recover([record("codex-dddddddddddd", 1004)]);
    assert.isUndefined(yield* recovered.sessionOf("codex-dddddddddddd"));
    assert.deepEqual(recovered.boundRecords, {});
    assert.deepEqual(recovered.fenced, ["codex-dddddddddddd:one", "codex-dddddddddddd:two"]);
    assert.deepEqual([...recovered.result.blockedThreads].sort(), ["one", "two"]);
    assert.equal((yield* recovered.detached.cleanup)[0]?.outcome, "retained");
    for (const session of ["session-one", "session-two", "session-other"])
      assert.equal(
        (yield* recovered.detached
          .ensureNotBlocked("codex", ProviderSessionId.make(session))
          .pipe(Effect.exit))._tag,
        "Failure",
      );
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("a fenced record from before the upgrade takes the session its fence's thread uses", () =>
  Effect.gen(function* () {
    yield* seedThread({ threadId: "goal", sessionId: "session-goal", running: false });
    yield* seedThread({ threadId: "busy", sessionId: "session-busy", running: true });
    const recovered = yield* recover([
      record("codex-eeeeeeeeeeee", 1005, {
        goalBlocks: [{ threadId: ThreadId.make("goal"), nativeThreadId: "native-goal" }],
      }),
    ]);
    assert.equal(yield* recovered.sessionOf("codex-eeeeeeeeeeee"), "session-goal");
    assert.deepEqual(recovered.boundRecords, {});
    assert.deepEqual(recovered.fenced, []);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("records from before the upgrade without one clear owner stay unassigned", () =>
  Effect.gen(function* () {
    yield* seedThread({ threadId: "shared", sessionId: "session-shared", running: true });
    const recovered = yield* recover([
      record("codex-ffffffffffff", 1006),
      record("codex-gggggggggggg", 1007),
      { ...record("idle-hhhhhhhhhhhh", 1008), instanceId: "idle" },
    ]);
    for (const name of ["codex-ffffffffffff", "codex-gggggggggggg", "idle-hhhhhhhhhhhh"])
      assert.isUndefined(yield* recovered.sessionOf(name));
    assert.deepEqual(recovered.boundRecords, {});
    assert.deepEqual(recovered.fenced, ["codex-ffffffffffff:shared", "codex-gggggggggggg:shared"]);
    assert.deepEqual([...recovered.result.blockedThreads], ["shared"]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
