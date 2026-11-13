import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as AutomationHold from "../automationHold.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

import {
  makeTestRelay,
  NOW,
  PROJECT_ID,
  SECOND_THREAD_ID,
  shell,
  THREAD_ID,
} from "./AgentAwarenessRelay.testkit.ts";

const publishedThreadId = (url: string | undefined) => url?.match(/\/threads\/([^/?]+)/)?.[1];

describe("AgentAwarenessRelay", () => {
  it.effect.each(["command", "user_input"] as const)(
    "notifies the parent once when a child waits for %s",
    (kind) =>
      Effect.gen(function* () {
        const child = ThreadId.make("child-approval");
        const childShell = shell({
          id: child,
          lineage: {
            rootThreadId: THREAD_ID,
            parentThreadId: THREAD_ID,
            relationshipToParent: "subagent",
          },
          createdBy: "agent",
          creationSource: "mcp",
          activityRunStatus: "running",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-child"),
            kind,
            createdAt: DateTime.makeUnsafe(NOW),
          },
        });
        const current = yield* Ref.make(childShell);
        const { relay, publications } = yield* makeTestRelay({
          readShell: (id) => (id === child ? Ref.get(current) : Effect.succeed(shell())),
        });
        yield* relay.publishThread(THREAD_ID);
        yield* relay.publishThread(child);
        assert.equal(publications.length, 2);
        assert.equal(
          publications[1]?.state?.phase,
          kind === "user_input" ? "waiting_for_input" : "waiting_for_approval",
        );
        assert.isTrue(publications[1]?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
        yield* relay.publishThread(child);
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications.length, 2);
        yield* Ref.set(current, { ...childShell, pendingRuntimeRequest: null });
        yield* relay.publishThread(child);
        assert.equal(publications[2]?.state?.phase, "running");
        yield* Ref.set(current, {
          ...childShell,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("another-request"),
            kind,
            createdAt: DateTime.makeUnsafe("2026-09-04T12:01:00.000Z"),
          },
        });
        yield* relay.publishThread(child);
        assert.equal(publications.length, 4);
        assert.notEqual(publications[3]?.state?.updatedAt, publications[1]?.state?.updatedAt);
      }),
  );
  it.effect(
    "held: publishes nothing and parks event consumption; release: publishes unchanged state",
    () =>
      Effect.gen(function* () {
        const hold = yield* AutomationHold.makeInMemory({
          reason: "channel-copy",
          heldAt: "2026-10-25T00:00:00.000Z",
        });
        const pulls = yield* Queue.unbounded<void>();
        const { relay, publications, catchUp } = yield* makeTestRelay({
          domainEvents: Stream.fromEffect(Queue.offer(pulls, undefined)).pipe(
            Stream.flatMap(() => Stream.never),
          ),
        }).pipe(Effect.provideService(AutomationHold.AutomationHold, hold));
        yield* relay.start();
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("1 second");
        assert.deepEqual(publications, []);
        assert.equal(yield* Queue.size(pulls), 0);
        assert.equal(catchUp.shellSnapshotReads, 0);
        yield* hold.release;
        yield* Queue.take(pulls);
        yield* relay.publishThread(THREAD_ID);
        assert.equal(publications.length, 1);
        assert.equal(publications[0]?.state?.phase, "running");
      }).pipe(Effect.scoped),
  );

  it.effect("sends a tombstone for silent completion after the existing confirmation timer", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications[0]?.state?.phase, "running");
      yield* Ref.set(
        currentShell,
        shell({ status: "completed", latestRunCompletionNotification: "silent" }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.isNull(publications[1]?.state);
    }).pipe(Effect.scoped),
  );

  it.effect("coalesces queued updates and reruns a thread dirtied during publishing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const rerunStarted = yield* Deferred.make<void>();
      const releaseRerun = yield* Deferred.make<void>();
      const processed: Array<{ threadId: ThreadId; revision: number }> = [];
      let revision = 1;
      const worker = yield* AgentAwarenessRelay.makeAgentAwarenessPublishWorker((threadId) =>
        Effect.gen(function* () {
          const currentRevision = revision;
          const index = processed.length;
          processed.push({ threadId, revision: currentRevision });
          if (index === 0) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          } else if (threadId === THREAD_ID) {
            yield* Deferred.succeed(rerunStarted, undefined);
            yield* Deferred.await(releaseRerun);
          }
        }),
      );
      yield* worker.enqueue(THREAD_ID);
      yield* Deferred.await(started);
      revision = 2;
      for (let i = 0; i < 100; i++) {
        yield* worker.enqueue(SECOND_THREAD_ID);
        yield* worker.enqueue(THREAD_ID);
      }
      const drained = yield* Deferred.make<void>();
      const draining = yield* worker.drain.pipe(
        Effect.andThen(Deferred.succeed(drained, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(rerunStarted);
      assert.isFalse(yield* Deferred.isDone(drained));
      yield* Deferred.succeed(releaseRerun, undefined);
      yield* Fiber.join(draining);
      assert.deepEqual(processed, [
        { threadId: THREAD_ID, revision: 1 },
        { threadId: SECOND_THREAD_ID, revision: 2 },
        { threadId: THREAD_ID, revision: 2 },
      ]);
    }),
  );

  it.effect("deduplicates state and republishes title changes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T13:00:00Z") }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell({ title: "Renamed thread" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.threadTitle, "Renamed thread");
    }),
  );

  it.effect("republishes unchanged state with fresh credentials after relinking", () =>
    Effect.gen(function* () {
      const { relay, secrets, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[0]?.authorization, "Bearer credential-1");
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
      yield* secrets.set(
        RELAY_URL_SECRET,
        new TextEncoder().encode("https://new-relay.example.test"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.isTrue(publications[2]?.url.startsWith("https://new-relay.example.test/") ?? false);
    }),
  );

  it.effect.each(["completed", "failed"] as const)(
    "publishes a tombstone when a %s thread is settled through a domain event",
    (status) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const pulls = yield* Queue.unbounded<void>();
        const { relay, currentShell, publications } = yield* makeTestRelay({
          domainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        });
        yield* relay.start();
        yield* Queue.take(pulls);
        yield* relay.publishThread(THREAD_ID);
        const terminal = shell({ status });
        yield* Ref.set(currentShell, terminal);
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications[1]?.state?.phase, status);

        const now = yield* DateTime.now;
        const settled = {
          ...terminal,
          settledOverride: "settled" as const,
          settledAt: now,
          lastVisitedAt: null,
        };
        yield* Ref.set(currentShell, settled);
        yield* Queue.offer(events, {
          id: EventId.make("event:settled"),
          type: "thread.settled",
          threadId: THREAD_ID,
          occurredAt: now,
          payload: settled,
        });
        yield* Queue.take(pulls);
        yield* relay.drain;
        assert.equal(publications.length, 2);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.equal(publications.length, 3);
        assert.equal(publications[2]?.state, null);
      }).pipe(Effect.scoped),
  );

  it.effect("holds a completion through a continuation gap, then publishes it once", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell());
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }),
  );

  it.effect("still publishes a completion when the thread settles during the hold", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );
    }),
  );

  it.effect("publishes a cleared thread's tombstone once while it stays cleared", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );

      for (let i = 0; i < 3; i++) {
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
      }
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", null],
      );
    }),
  );

  it.effect(
    "publishes an archived or deleted thread's tombstone once, skips later events while it stays gone, and republishes one that comes back",
    () =>
      Effect.gen(function* () {
        const shells = new Map([
          [THREAD_ID, shell()],
          [SECOND_THREAD_ID, shell({ id: SECOND_THREAD_ID })],
        ]);
        const { relay, publications } = yield* makeTestRelay({
          readShell: (id) => Effect.sync(() => shells.get(id) ?? null),
        });
        const phases = () => publications.map((publication) => publication.state?.phase ?? null);
        yield* relay.publishThread(THREAD_ID);
        yield* relay.publishThread(SECOND_THREAD_ID);

        shells.set(THREAD_ID, shell({ archivedAt: DateTime.makeUnsafe(NOW) }));
        shells.delete(SECOND_THREAD_ID);
        yield* relay.publishThread(THREAD_ID);
        yield* relay.publishThread(SECOND_THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.deepEqual(phases(), ["running", "running", null, null]);

        // A rename or pull request sync on a thread that stays archived or deleted.
        yield* relay.publishThread(THREAD_ID);
        yield* relay.publishThread(SECOND_THREAD_ID);
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.deepEqual(phases(), ["running", "running", null, null]);

        shells.set(THREAD_ID, shell());
        yield* relay.publishThread(THREAD_ID);
        assert.deepEqual(phases(), ["running", "running", null, null, "running"]);
        assert.equal(publishedThreadId(publications[4]?.url), THREAD_ID);
      }),
  );

  it.effect(
    "bound: past the cap evicts the least recently published idle threads, never one with a pending confirmation",
    () =>
      Effect.gen(function* () {
        const third = ThreadId.make("relay-thread-3");
        const fourth = ThreadId.make("relay-thread-4");
        const shells = new Map(
          [THREAD_ID, SECOND_THREAD_ID, third, fourth].map((id) => [id, shell({ id })]),
        );
        const { relay, publications, publishedStates } = yield* makeTestRelay({
          readShell: (id) => Effect.sync(() => shells.get(id) ?? null),
          maxPublishedThreads: 2,
        });
        const remembered = Effect.map(Ref.get(publishedStates), (states) => [...states.keys()]);
        yield* relay.publishThread(THREAD_ID);
        yield* relay.publishThread(SECOND_THREAD_ID);
        // The oldest thread now waits on its tombstone's confirmation window.
        shells.set(THREAD_ID, shell({ archivedAt: DateTime.makeUnsafe(NOW) }));
        yield* relay.publishThread(THREAD_ID);
        yield* relay.publishThread(third);
        assert.deepEqual(yield* remembered, [THREAD_ID, third]);
        yield* relay.publishThread(fourth);
        assert.deepEqual(yield* remembered, [THREAD_ID, fourth]);

        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.deepEqual(yield* remembered, [fourth, THREAD_ID]);
        assert.deepEqual(
          publications.map((publication) => [
            publishedThreadId(publication.url),
            publication.state?.phase ?? null,
          ]),
          [
            [THREAD_ID, "running"],
            [SECOND_THREAD_ID, "running"],
            [third, "running"],
            [fourth, "running"],
            [THREAD_ID, null],
          ],
        );
      }),
  );

  it.effect("bound: an evicted thread republishes once on its next event, then skips repeats", () =>
    Effect.gen(function* () {
      const third = ThreadId.make("relay-thread-3");
      const shells = new Map([THREAD_ID, SECOND_THREAD_ID, third].map((id) => [id, shell({ id })]));
      const { relay, publications, publishedStates } = yield* makeTestRelay({
        readShell: (id) => Effect.sync(() => shells.get(id) ?? null),
        maxPublishedThreads: 2,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* relay.publishThread(SECOND_THREAD_ID);
      yield* relay.publishThread(third);
      assert.isFalse((yield* Ref.get(publishedStates)).has(THREAD_ID));

      yield* relay.publishThread(THREAD_ID);
      yield* relay.publishThread(THREAD_ID);
      assert.deepEqual(
        publications.map((publication) => publishedThreadId(publication.url)),
        [THREAD_ID, SECOND_THREAD_ID, third, THREAD_ID],
      );
      assert.deepEqual([...(yield* Ref.get(publishedStates)).keys()], [third, THREAD_ID]);
    }),
  );

  it.effect("does not alert an old completion after publishing its thread's tombstone", () =>
    Effect.gen(function* () {
      const oldCompleted = shell({
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
      });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(currentShell, {
        ...oldCompleted,
        settledOverride: "settled",
        settledAt: DateTime.makeUnsafe(NOW),
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state),
        [null],
      );

      yield* Ref.set(currentShell, oldCompleted);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state),
        [null],
      );
    }),
  );

  it.effect("alerts a completion settled during its hold after an earlier tombstone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
      const { relay, currentShell, publications } = yield* makeTestRelay();
      const settledAt = DateTime.makeUnsafe(NOW);
      yield* Ref.set(currentShell, {
        ...shell({ status: "completed" }),
        settledOverride: "settled",
        settledAt,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;

      const completed = shell({
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:06.000Z"),
      });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt,
        lastVisitedAt: null,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        [null, "completed", null],
      );
    }),
  );

  it.effect("drops a held completion when a queued continuation hides the thread", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "completed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ status: "queued" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.notInclude(
        publications.map((publication) => publication.state?.phase ?? null),
        "completed",
      );
    }),
  );

  it.effect("retries a failed completion even after the thread settles", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 2
            ? new Response("unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
        lastVisitedAt: null,
      });
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase ?? null),
        ["running", "completed", "completed"],
      );

      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state ?? null, null);
    }),
  );

  it.effect("keeps settled live work until its awaited monitor finishes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      const held = shell({
        status: "completed",
        settledOverride: "settled",
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
      });
      yield* Ref.set(currentShell, held);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "running");

      yield* Ref.set(currentShell, { ...held, pendingBackgroundTasks: [] });
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state, null);
    }),
  );
  it.effect("publishes a held completion when its background item ends, not on tool output", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, shellReads, publications } = yield* makeTestRelay({
        readShell: (threadId) => store.getThreadShell(threadId).pipe(Effect.orDie),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const deliver = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
        yield* store.apply(event);
        yield* Queue.offer(events, event);
        yield* Queue.take(pulls);
        yield* relay.drain;
      });

      const now = yield* DateTime.now;
      const runId = RunId.make("run:held-item");
      const run = {
        id: runId,
        threadId: THREAD_ID,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:held-item"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const item = (
        id: string,
        fields: Pick<OrchestrationV2TurnItem, "status"> &
          (
            | { readonly type: "dynamic_tool"; readonly toolName: string; readonly input: unknown }
            | {
                readonly type: "assistant_message";
                readonly messageId: MessageId;
                readonly text: string;
                readonly streaming: boolean;
              }
          ),
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: THREAD_ID,
        runId,
        nodeId: NodeId.make("node:held-item"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        ...fields,
      });
      const itemEvent = (id: string, payload: OrchestrationV2TurnItem) =>
        ({
          id: EventId.make(id),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          runId,
          occurredAt: now,
          payload,
        }) satisfies OrchestrationV2DomainEvent;
      const background = { type: "dynamic_tool" as const, toolName: "watch", input: {} };

      yield* deliver({
        id: EventId.make("event:held-item:thread"),
        type: "thread.created",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* deliver({
        id: EventId.make("event:held-item:run"),
        type: "run.created",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: run,
      });
      yield* deliver(
        itemEvent("event:held-item:tool", item("item:tool", { ...background, status: "running" })),
      );
      yield* deliver({
        id: EventId.make("event:held-item:run-completed"),
        type: "run.updated",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      const readsBeforeOutput = shellReads.length;
      yield* deliver(
        itemEvent(
          "event:held-item:reply",
          item("item:reply", {
            type: "assistant_message",
            messageId: MessageId.make("message:held-item:reply"),
            text: "Still watching",
            streaming: true,
            status: "running",
          }),
        ),
      );
      yield* deliver(
        itemEvent("event:held-item:tick", item("item:tool", { ...background, status: "running" })),
      );
      assert.equal(shellReads.length, readsBeforeOutput);

      yield* deliver(
        itemEvent("event:held-item:end", item("item:tool", { ...background, status: "completed" })),
      );
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }).pipe(Effect.scoped, Effect.provide(ProjectionStore.layerMemory)),
  );
});

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

it.effect(
  "publisher 429 deadlines survive fresh events and preserve completion before its tombstone",
  () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 2
            ? Response.json(
                {
                  _tag: "RelayRateLimitExceededError",
                  code: "rate_limit_exceeded",
                  operation: "activity_publish",
                  retryAfterSeconds: 60,
                  traceId: "fixture",
                },
                { status: 429, headers: { "retry-after": "60" } },
              )
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      const completed = shell({ status: "completed" });
      yield* Ref.set(currentShell, completed);
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      yield* Ref.set(currentShell, {
        ...completed,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
      });
      yield* relay.publishThread(THREAD_ID);
      yield* relay.drain;
      yield* TestClock.adjust("59 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((p) => p.state?.phase ?? null),
        ["running", "completed", "completed"],
      );
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.at(-1)?.state, null);
    }),
);

it.effect("catches up after startup without polling after success", () =>
  Effect.gen(function* () {
    const { relay, secrets, secretReads, catchUp } = yield* makeTestRelay();
    yield* relay.start();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 1);

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 1);

    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 2);

    const readsBeforeIdle = secretReads.length;
    yield* TestClock.adjust("10 minutes");
    assert.equal(catchUp.shellSnapshotReads, 2);
    assert.equal(secretReads.length, readsBeforeIdle);

    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      new TextEncoder().encode("credential-2"),
    );
    yield* relay.requestCatchUp();
    yield* TestClock.adjust("1 second");
    assert.equal(catchUp.shellSnapshotReads, 3);
  }).pipe(Effect.scoped),
);
