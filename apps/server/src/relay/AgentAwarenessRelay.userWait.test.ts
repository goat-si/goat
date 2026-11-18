import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SecretRequestStatus,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { makeTestRelay, NOW, shell, THREAD_ID } from "./AgentAwarenessRelay.testkit.ts";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

const CHILD_THREAD_ID = ThreadId.make("user-wait-child");
const now = DateTime.makeUnsafe(NOW);
const waitingChild = () =>
  shell({
    id: CHILD_THREAD_ID,
    creationSource: "mcp",
    createdBy: "agent",
    activityRunStatus: "running",
    lineage: {
      rootThreadId: THREAD_ID,
      parentThreadId: THREAD_ID,
      relationshipToParent: "subagent",
    },
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("child-card"),
      kind: "user_input",
      createdAt: now,
      blocking: true,
      userOnly: true,
    },
  });
const itemBase = {
  threadId: CHILD_THREAD_ID,
  runId: RunId.make("run:child-card"),
  nodeId: NodeId.make("node:child-card"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "waiting" as const,
  title: "Card",
  startedAt: now,
  completedAt: null,
  updatedAt: now,
};

// The card's turn item is the only event recorded for the child when it appears.
const publishesOnCard = (payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const child = waitingChild();
    const parent = shell({ status: "completed" });
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const pulls = yield* Queue.unbounded<void>();
    const { relay, publications } = yield* makeTestRelay({
      readShell: (threadId) => Effect.succeed(threadId === child.id ? child : parent),
      domainEvents: Stream.fromEffectRepeat(
        Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
      ),
    });
    yield* relay.start();
    yield* Queue.take(pulls);
    yield* Queue.offer(events, {
      id: EventId.make("event:child-card"),
      type: "turn-item.updated",
      threadId: CHILD_THREAD_ID,
      runId: itemBase.runId,
      occurredAt: now,
      payload: { ...itemBase, id: TurnItemId.make("child-card"), ...payload },
    } as OrchestrationV2DomainEvent);
    yield* Queue.take(pulls);
    yield* relay.drain;
    assert.equal(publications.length, 1);
    assert.isTrue(publications[0]?.url.includes(`/threads/${THREAD_ID}/`) ?? false);
    assert.equal(publications[0]?.state?.phase, "waiting_for_input");
  }).pipe(Effect.scoped);

it.effect("publishes the parent as needing input when its subagent raises a secret card", () =>
  publishesOnCard({
    type: "secret_request",
    label: "SMS code",
    reason: "The agent needs the code.",
    secretStatus: "pending",
  }),
);

it.effect("publishes the parent as needing input when its subagent shows a human handoff", () =>
  publishesOnCard({ type: "human_handoff", handoff: { kind: "login", title: "Sign in" } }),
);

it.effect("keeps an ordinary subagent transcript update off the push", () =>
  Effect.gen(function* () {
    const parent = shell({ status: "completed" });
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const pulls = yield* Queue.unbounded<void>();
    const { relay, publications } = yield* makeTestRelay({
      readShell: (threadId) =>
        Effect.succeed(
          threadId === CHILD_THREAD_ID
            ? { ...waitingChild(), pendingRuntimeRequest: null }
            : parent,
        ),
      domainEvents: Stream.fromEffectRepeat(
        Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
      ),
    });
    yield* relay.start();
    yield* Queue.take(pulls);
    yield* Queue.offer(events, {
      id: EventId.make("event:child-command"),
      type: "turn-item.updated",
      threadId: CHILD_THREAD_ID,
      runId: itemBase.runId,
      occurredAt: now,
      payload: {
        ...itemBase,
        id: TurnItemId.make("child-command"),
        status: "running",
        type: "command_execution",
        input: "pnpm test",
      },
    } as OrchestrationV2DomainEvent);
    yield* Queue.take(pulls);
    yield* relay.drain;
    assert.equal(publications.length, 0);
  }).pipe(Effect.scoped),
);

it.effect(
  "pushes a pending secret card once across its updates, without its text, and clears it when answered",
  () =>
    Effect.gen(function* () {
      let child = waitingChild();
      const parent = shell({ status: "completed" });
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) => Effect.succeed(threadId === child.id ? child : parent),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      const card = (secretStatus: OrchestrationV2SecretRequestStatus, id: string) =>
        ({
          id: EventId.make(id),
          type: "turn-item.updated",
          threadId: CHILD_THREAD_ID,
          runId: itemBase.runId,
          occurredAt: now,
          payload: {
            ...itemBase,
            id: TurnItemId.make("child-card"),
            type: "secret_request",
            label: "SMS code",
            reason: "The agent needs the code.",
            secretStatus,
          },
        }) as OrchestrationV2DomainEvent;
      yield* relay.start();
      yield* Queue.take(pulls);
      yield* Queue.offer(events, card("pending", "event:card-1"));
      yield* Queue.take(pulls);
      yield* relay.drain;
      yield* Queue.offer(events, card("pending", "event:card-2"));
      yield* Queue.take(pulls);
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "waiting_for_input");
      const pushed = JSON.stringify(publications[0]?.state);
      assert.notInclude(pushed, "SMS code");
      assert.notInclude(pushed, "The agent needs the code.");

      // Answering the card ends the child's wait.
      child = { ...waitingChild(), pendingRuntimeRequest: null };
      yield* Queue.offer(events, card("saved", "event:card-3"));
      yield* Queue.take(pulls);
      // The relay confirms a move into completed before publishing it.
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.notEqual(publications[1]?.state?.phase, "waiting_for_input");
    }).pipe(Effect.scoped),
);
