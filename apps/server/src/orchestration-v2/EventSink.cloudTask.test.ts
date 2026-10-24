import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  MessageId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { registerCredentialRunTag } from "../mcp/goatCredentialRedaction.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeCloudResultEvents } from "./CloudResultEvents.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = EventSink.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const makeOwner = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:cloud-metadata");
  const thread = idleThreadProjection(liveThreadShell(threadId)).thread;
  const provider: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("pt:cloud-metadata"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("ps:cloud-metadata"),
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("codex"),
      nativeId: "native-session",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    cloudTask: {
      taskId: "task-1",
      acceptedAppRunId: RunId.make("run:cloud-metadata"),
      status: "succeeded",
      tracking: "live",
      source: { repository: "https://github.com/acme/repo", branch: "dev" },
      summary: "Final summary",
      prUrl: "https://github.com/acme/repo/pull/1",
      branch: "agent/fix",
      url: "https://example.com/task/1",
      localChangesExcluded: true,
      updatedAt: DateTime.formatIso(now),
    },
  };
  const run: OrchestrationV2Run = {
    id: RunId.make("run:cloud-metadata"),
    threadId,
    ordinal: 1,
    providerInstanceId: provider.providerInstanceId,
    modelSelection: thread.modelSelection,
    providerThreadId: provider.id,
    userMessageId: MessageId.make("message:cloud-metadata"),
    rootNodeId: NodeId.make("node:cloud-metadata"),
    activeAttemptId: RunAttemptId.make("attempt:cloud-metadata"),
    status: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make("seed:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make("seed:provider"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: provider,
      },
      {
        id: EventId.make("seed:run"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: run,
      },
    ],
  });
  const input: Parameters<EventSink.EventSinkV2Shape["writeCloudTaskMetadata"]>[0] = {
    eventId: EventId.make("metadata:updated"),
    threadId,
    providerThreadId: provider.id,
    providerSessionId: provider.providerSessionId!,
    providerInstanceId: provider.providerInstanceId,
    runId: run.id,
    activeAttemptId: run.activeAttemptId!,
    expectedLastRunOrdinal: 1,
    nativeId: "native-session",
    metadata: { title: "Late title", progress: "Blocked", url: "https://example.com/task/updated" },
  };
  const writeOwner = (nextRun = run, nextProvider = provider) =>
    sink.write({
      events: [
        {
          id: EventId.make("owner:run"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: nextRun,
        },
        {
          id: EventId.make("owner:provider"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: nextProvider,
        },
      ],
    });
  const read = () => projections.getThreadProjection(threadId);
  return { sink, input, run, provider, writeOwner, read };
});

it.effect(
  "cloud result items survive duplicate finalization and replay without changing history",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeOwner;
      const threadId = owner.run.threadId;
      const now = yield* DateTime.now;
      const messageId = MessageId.make(`message:cloud-result:${owner.run.id}`);
      const itemId = TurnItemId.make(`turn-item:cloud-result:${owner.run.id}`);
      const text = "Final summary\nPull request: https://github.com/acme/repo/pull/1";
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make("cloud-result:message"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId: owner.run.id,
            nodeId: owner.run.rootNodeId,
            createdBy: "agent",
            creationSource: "provider",
            role: "assistant",
            text,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("cloud-result:item"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: itemId,
            type: "assistant_message",
            threadId,
            runId: owner.run.id,
            nodeId: owner.run.rootNodeId,
            providerThreadId: owner.provider.id,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            messageId,
            text,
            streaming: false,
          },
        },
      ];
      const rejected = yield* owner.sink.writeIfRunCurrent({
        threadId,
        runId: owner.run.id,
        activeAttemptId: RunAttemptId.make("attempt:superseded"),
        expectedStatus: "running",
        events,
      });
      assert.isFalse(rejected.committed);
      assert.equal((yield* owner.read()).turnItems.length, 0);
      const writes = yield* Effect.all(
        [
          owner.sink.writeWithEffects({ events, effects: [] }),
          owner.sink.writeWithEffects({
            events: events.map((event) => ({
              ...event,
              id: EventId.make(`${event.id}:duplicate`),
            })),
            effects: [],
          }),
        ],
        { concurrency: 2 },
      );
      assert.equal(writes.flat().length, 2);
      const before = yield* owner.read();
      assert.equal(before.turnItems.length, 1);
      assert.equal(before.turnItems[0]!.id, itemId);
      assert.equal(before.visibleTurnItems[0]!.sourceItemId, itemId);
      const sequence = yield* owner.sink.latestSequence();
      const replay = yield* owner.sink.writeWithEffects({
        events: events.map((event) => {
          // Changed replay text must not replace the original result message.
          if (event.type === "message.updated")
            return {
              ...event,
              id: EventId.make(`${event.id}:replay`),
              payload: {
                ...event.payload,
                text: "Stale replay text",
                updatedAt: DateTime.add(now, { seconds: 1 }),
              },
            };
          return { ...event, id: EventId.make(`${event.id}:replay`) };
        }),
        effects: [],
      });
      assert.deepEqual(replay, []);
      assert.equal(yield* owner.sink.latestSequence(), sequence);
      assert.deepEqual(yield* owner.read(), before);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "merges whitelisted metadata on a %s owner without changing terminal state",
  (status) =>
    Effect.gen(function* () {
      const owner = yield* makeOwner;
      yield* owner.writeOwner(
        { ...owner.run, status },
        {
          ...owner.provider,
          cloudTask: {
            ...owner.provider.cloudTask!,
            status: status === "failed" ? "unknown" : "succeeded",
            error: "Retain error",
          },
        },
      );
      const before = yield* owner.read();
      // Runtime callers may supply extra fields even though the SPI excludes them.
      const metadata = {
        ...owner.input.metadata,
        status: "running",
        taskId: "foreign",
        acceptedAppRunId: RunId.make("run:foreign"),
        summary: "stale",
        source: { branch: "stale" },
        prUrl: "stale",
      };
      yield* owner.sink.writeCloudTaskMetadata({ ...owner.input, metadata });
      const after = yield* owner.read();
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.attempts, before.attempts);
      assert.deepEqual(after.nodes, before.nodes);
      assert.equal(after.thread.settledAt, before.thread.settledAt);
      assert.deepEqual(after.messages, before.messages);
      const { updatedAt: _beforeAt, ...saved } = before.providerThreads[0]!.cloudTask!;
      const { updatedAt: _afterAt, ...merged } = after.providerThreads[0]!.cloudTask!;
      assert.deepEqual(merged, { ...saved, ...owner.input.metadata });
      assert.equal(after.providerThreads[0]!.status, before.providerThreads[0]!.status);
      const sequence = yield* owner.sink.latestSequence();
      yield* owner.sink.writeCloudTaskMetadata({
        ...owner.input,
        eventId: EventId.make("metadata:duplicate"),
      });
      assert.equal(yield* owner.sink.latestSequence(), sequence);
      assert.deepEqual(yield* owner.read(), after);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "running",
  "queued",
  "waiting",
  "rolled_back",
  "attempt",
  "ordinal",
  "native",
  "session",
  "instance",
  "thread",
  "provider",
  "root",
  "newer",
  "newer-submitting",
] as const)("rejects stale metadata: %s", (reason) =>
  Effect.gen(function* () {
    const owner = yield* makeOwner;
    let run = owner.run;
    let provider = owner.provider;
    let input = owner.input;
    switch (reason) {
      case "running":
      case "queued":
      case "waiting":
      case "rolled_back":
        run = { ...run, status: reason };
        break;
      case "attempt":
        run = { ...run, activeAttemptId: RunAttemptId.make("attempt:replacement") };
        break;
      case "ordinal":
        provider = { ...provider, lastRunOrdinal: 2 };
        break;
      case "native":
        input = { ...input, nativeId: "foreign-session" };
        break;
      case "session":
        input = { ...input, providerSessionId: ProviderSessionId.make("ps:replacement") };
        break;
      case "instance":
        input = { ...input, providerInstanceId: ProviderInstanceId.make("foreign") };
        break;
      case "thread":
        input = { ...input, threadId: ThreadId.make("thread:foreign") };
        break;
      case "provider":
        run = { ...run, providerThreadId: ProviderThreadId.make("pt:foreign") };
        break;
      case "root":
        provider = { ...provider, ownerNodeId: NodeId.make("node:subagent") };
        break;
      case "newer":
      case "newer-submitting":
        yield* owner.sink.write({
          events: [
            {
              id: EventId.make("owner:newer-run"),
              type: "run.created",
              threadId: run.threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...run, id: RunId.make("run:newer"), ordinal: 2, status: "running" },
            },
          ],
        });
        if (reason === "newer-submitting")
          provider = {
            ...provider,
            cloudTask: { ...provider.cloudTask!, taskId: "new-task", status: "submitting" },
          };
        break;
    }
    yield* owner.writeOwner(run, provider);
    const before = yield* owner.read();
    const sequence = yield* owner.sink.latestSequence();
    yield* owner.sink.writeCloudTaskMetadata(input);
    assert.equal(yield* owner.sink.latestSequence(), sequence);
    assert.deepEqual(yield* owner.read(), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "javascript:alert(1)",
  "https://user:pass@example.com/",
  "not a url",
  `https://example.com/${"x".repeat(2048)}`,
])("ignores unusable URLs and bounds display metadata (%s)", (url) =>
  Effect.gen(function* () {
    const owner = yield* makeOwner;
    const sequence = yield* owner.sink.latestSequence();
    yield* owner.sink.writeCloudTaskMetadata({ ...owner.input, metadata: { url } });
    assert.equal(yield* owner.sink.latestSequence(), sequence);
    yield* owner.sink.writeCloudTaskMetadata({
      ...owner.input,
      metadata: { url, title: "t".repeat(600), progress: "p".repeat(2100) },
    });
    const task = (yield* owner.read()).providerThreads[0]!.cloudTask!;
    assert.equal(task.url, owner.provider.cloudTask!.url);
    assert.equal(task.title?.length, 512);
    assert.equal(task.progress?.length, 2000);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["attempt", "newer-run"] as const)(
  "rejects metadata racing a transactional %s ownership change",
  (change) =>
    Effect.gen(function* () {
      const owner = yield* makeOwner;
      const sql = yield* SqlClient.SqlClient;
      const locked = yield* Deferred.make<void>();
      const attempting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const initialSequence = yield* owner.sink.latestSequence();
      const writer = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (change === "attempt") {
              yield* owner.writeOwner({
                ...owner.run,
                activeAttemptId: RunAttemptId.make("attempt:replacement"),
              });
            } else {
              yield* owner.sink.write({
                events: [
                  {
                    id: EventId.make("owner:concurrent-run"),
                    type: "run.created",
                    threadId: owner.run.threadId,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      ...owner.run,
                      id: RunId.make("run:replacement"),
                      ordinal: 2,
                      status: "queued",
                    },
                  },
                ],
              });
            }
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const metadata = yield* Deferred.succeed(attempting, undefined).pipe(
        Effect.andThen(owner.sink.writeCloudTaskMetadata(owner.input)),
        Effect.forkChild,
      );
      yield* Deferred.await(attempting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      yield* Fiber.join(metadata);
      assert.equal((yield* owner.read()).providerThreads[0]!.cloudTask?.title, undefined);
      assert.equal(
        yield* owner.sink.latestSequence(),
        initialSequence + (change === "attempt" ? 2 : 1),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect(
  "reads the latest task and ownership inside the transaction after a concurrent writer",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeOwner;
      const sql = yield* SqlClient.SqlClient;
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* owner.writeOwner(owner.run, {
              ...owner.provider,
              cloudTask: {
                ...owner.provider.cloudTask!,
                summary: "Newest final summary",
                status: "unknown",
              },
            });
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const metadata = yield* owner.sink.writeCloudTaskMetadata(owner.input).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      yield* Fiber.join(metadata);
      const task = (yield* owner.read()).providerThreads[0]!.cloudTask!;
      assert.equal(task.summary, "Newest final summary");
      assert.equal(task.status, "unknown");
      assert.equal(task.title, "Late title");
      // A newer rolled-back run does not take ownership; other newer runs do.
      yield* owner.sink.write({
        events: [
          {
            id: EventId.make("newer:rolled-back"),
            type: "run.created",
            threadId: owner.run.threadId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...owner.run,
              id: RunId.make("run:rolled-back"),
              ordinal: 2,
              status: "rolled_back",
            },
          },
        ],
      });
      yield* owner.sink.writeCloudTaskMetadata({
        ...owner.input,
        eventId: EventId.make("metadata:after-rollback"),
        metadata: { title: "After rollback" },
      });
      assert.equal((yield* owner.read()).providerThreads[0]!.cloudTask?.title, "After rollback");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect(
  "a cloud result repeating a provider message that held a GOAT token is still one item",
  () =>
    Effect.gen(function* () {
      registerCredentialRunTag("testtag0");
      const owner = yield* makeOwner;
      const threadId = owner.run.threadId;
      const now = yield* DateTime.now;
      // Synthetic, shaped like an issued MCP credential.
      const text = "Done. Token was testtag0SyntheticMcpTokenNotARealCredential00000000";
      yield* owner.sink.write({
        events: [
          {
            id: EventId.make("provider:item"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:provider-answer"),
              type: "assistant_message",
              threadId,
              runId: owner.run.id,
              nodeId: owner.run.rootNodeId,
              providerThreadId: owner.provider.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              messageId: MessageId.make("message:provider-answer"),
              text,
              streaming: false,
            },
          },
        ],
      });
      let next = 0;
      const events = yield* makeCloudResultEvents({
        run: owner.run,
        nodeId: owner.run.rootNodeId!,
        providerThreadId: owner.provider.id,
        providerTurnId: null,
        text,
        completedAt: now,
        allocateEventId: () => Effect.succeed(EventId.make(`cloud-result:${next++}`)),
      });
      yield* owner.sink.writeWithEffects({ events, effects: [] });

      const items = (yield* owner.read()).turnItems.filter(
        (item) => item.type === "assistant_message",
      );
      assert.deepEqual(
        items.map((item) => (item.type === "assistant_message" ? item.text : "")),
        ["Done. Token was [redacted]"],
      );
    }).pipe(Effect.provide(layerTest)),
);
