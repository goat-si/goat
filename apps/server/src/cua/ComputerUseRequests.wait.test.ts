import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, RunId, type TurnItemId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import type * as Handoffs from "../handoffs/Handoffs.ts";
import type * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { purpose, sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

const WAIT = Duration.minutes(10);
const APP = "com.example.AppA";

type Orchestrator = Parameters<Parameters<typeof withHarness>[0]>[0]["orchestrator"];
interface Waiting {
  readonly request: Parameters<Parameters<typeof withRequests>[2]>[0]["request"];
  readonly handoffs: Handoffs.Handoffs["Service"];
  readonly leases: ComputerUseLeases.ComputerUseLeases["Service"];
  readonly orchestrator: Orchestrator;
  readonly runId: RunId;
  /** The next computer use request card this thread creates, once committed. */
  readonly created: () => Effect.Effect<TurnItemId>;
}

/** The request path over a running turn, with a hook for each card it creates. */
const withWaiting = <E, R>(body: (input: Waiting) => Effect.Effect<void, E, R>) =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const cards: Array<Deferred.Deferred<TurnItemId>> = [];
      let next = 0;
      const slot = (index: number) =>
        Effect.gen(function* () {
          while (cards.length <= index) cards.push(yield* Deferred.make<TurnItemId>());
          return cards[index]!;
        });
      const runId = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.id;
      yield* withRequests(
        orchestrator,
        supported,
        ({ request, handoffs, leases }) =>
          body({
            request,
            handoffs,
            leases,
            orchestrator,
            runId,
            created: () => slot(next++).pipe(Effect.flatMap(Deferred.await)),
          }),
        undefined,
        undefined,
        undefined,
        Option.none(),
        (command) =>
          command.type === "handoff.create"
            ? Effect.gen(function* () {
                const index = cards.filter(Deferred.isDoneUnsafe).length;
                yield* Deferred.succeed(yield* slot(index), command.handoff.handoffId);
              })
            : Effect.void,
      );
    }),
  );

const answer = (
  handoffs: Handoffs.Handoffs["Service"],
  handoffId: TurnItemId,
  action: "completed" | "declined" | "cancelled",
) => handoffs.respond({ threadId, handoffId, action }, sessionId);

it.effect(
  "a person's approval answers the waiting request in the same call, for this turn's control",
  () =>
    withWaiting(({ request, handoffs, leases, runId, created }) =>
      Effect.gen(function* () {
        const control = yield* leases.control(threadId, Option.none(), runId);
        const waiting = yield* request({ apps: [APP] }, WAIT).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* answer(handoffs, yield* created(), "completed");
        const result = yield* Fiber.join(waiting);
        assert.equal(result.kind, "available");
        assert.include(result.message, "Go on in this turn");
        // The control this turn already holds acts on the app now; no new turn is needed.
        const state = yield* leases.controlState(threadId, control.controlId);
        assert.deepInclude(state, { _tag: "active", apps: [APP] });
      }),
    ),
);

it.effect("an approved foreground request lets this turn's control take the foreground", () =>
  withWaiting(({ request, handoffs, leases, runId, created }) =>
    Effect.gen(function* () {
      const control = yield* leases.control(threadId, Option.none(), runId);
      const waiting = yield* request({ foreground: true }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* answer(handoffs, yield* created(), "completed");
      assert.equal((yield* Fiber.join(waiting)).kind, "available");
      assert.isTrue(yield* leases.foregroundAvailable(threadId, purpose));
      const state = yield* leases.controlState(threadId, control.controlId);
      assert.lengthOf(state._tag === "active" ? (state.foreground ?? []) : [], 1);
    }),
  ),
);

it.effect.each(["declined", "cancelled"] as const)(
  "a person who %s the request gets that refusal back in the same call",
  (action) =>
    withWaiting(({ request, handoffs, leases, runId, created }) =>
      Effect.gen(function* () {
        yield* leases.control(threadId, Option.none(), runId);
        const waiting = yield* request({ apps: [APP] }, WAIT).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* answer(handoffs, yield* created(), action);
        assert.deepInclude(yield* Fiber.join(waiting), { kind: "refused", reason: action });
      }),
    ),
);

it.effect("a request that expires while the call waits reports expired", () =>
  withWaiting(({ request, leases, runId, created }) =>
    Effect.gen(function* () {
      yield* leases.control(threadId, Option.none(), runId);
      const waiting = yield* request({ apps: [APP], minutes: 5 }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* created();
      yield* TestClock.adjust("5 minutes");
      assert.deepInclude(yield* Fiber.join(waiting), { kind: "refused", reason: "expired" });
    }),
  ),
);

it.effect("a call that waited its budget leaves the request open and says so", () =>
  withWaiting(({ request, handoffs, leases, runId, created }) =>
    Effect.gen(function* () {
      yield* leases.control(threadId, Option.none(), runId);
      const waiting = yield* request({ apps: [APP] }, Duration.minutes(1)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const handoffId = yield* created();
      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(waiting);
      assert.equal(result.kind, "needs_human");
      assert.isTrue(result.kind === "needs_human" && result.waitTimedOut === true);
      assert.equal((yield* handoffs.read({ threadId, handoffId })).state, "pending");
    }),
  ),
);

it.effect("a newer different request replaces a pending one, whose call reports it", () =>
  withWaiting(({ request, handoffs, leases, runId, created }) =>
    Effect.gen(function* () {
      yield* leases.control(threadId, Option.none(), runId);
      const first = yield* request({ apps: [APP] }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* created();
      const second = yield* request({ apps: ["com.example.AppB"] }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const newer = yield* created();
      assert.deepInclude(yield* Fiber.join(first), { kind: "refused", reason: "superseded" });
      yield* answer(handoffs, newer, "completed");
      assert.equal((yield* Fiber.join(second)).kind, "available");
    }),
  ),
);

it.effect("an approval that lands first keeps its grant when a different request follows", () =>
  withWaiting(({ request, handoffs, leases, runId, created }) =>
    Effect.gen(function* () {
      const control = yield* leases.control(threadId, Option.none(), runId);
      const first = yield* request({ apps: [APP] }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* answer(handoffs, yield* created(), "completed");
      assert.equal((yield* Fiber.join(first)).kind, "available");
      const second = yield* request({ apps: ["com.example.AppB"] }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* answer(handoffs, yield* created(), "completed");
      assert.equal((yield* Fiber.join(second)).kind, "available");
      const state = yield* leases.controlState(threadId, control.controlId);
      assert.deepInclude(state, { _tag: "active", apps: [APP, "com.example.AppB"] });
    }),
  ),
);

it.effect("an approval after Stop does not reach the stopped turn", () =>
  withWaiting(({ request, handoffs, leases, runId, created }) =>
    Effect.gen(function* () {
      yield* leases.control(threadId, Option.none(), runId);
      const waiting = yield* request({ apps: [APP] }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const handoffId = yield* created();
      yield* leases.stop(threadId);
      yield* answer(handoffs, handoffId, "completed");
      assert.deepInclude(yield* Fiber.join(waiting), { kind: "refused", reason: "interrupted" });
    }),
  ),
);

it.effect("a turn without its own computer use control asks and returns at once", () =>
  withWaiting(({ request }) =>
    Effect.gen(function* () {
      const result = yield* request({ apps: [APP] }, WAIT);
      assert.equal(result.kind, "needs_human");
      assert.isFalse(result.kind === "needs_human" && result.waitTimedOut === true);
    }),
  ),
);

it.effect(
  "a person's full access turn asks for nothing: apps and foreground are already its own",
  () =>
    withWaiting(({ request, leases, orchestrator, runId }) =>
      Effect.gen(function* () {
        yield* leases.everyAppControl(threadId, false, { person: true, runId });
        assert.equal((yield* request({ apps: [APP] }, WAIT)).kind, "available");
        assert.equal((yield* request({ foreground: true }, WAIT)).kind, "available");
        assert.deepInclude(yield* request({ foreground: true, apps: [APP] }, WAIT), {
          kind: "refused",
          reason: "unsupported",
        });
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
      }),
    ),
);

it.effect("a request is judged by the running turn, not a scheduled one queued behind it", () =>
  withWaiting(({ request, handoffs, leases, orchestrator, runId, created }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue-scheduled"),
        threadId,
        messageId: MessageId.make("message:scheduled"),
        text: "Scheduled follow-up",
        attachments: [],
        scheduledTaskId: "task:nightly" as never,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      });
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isTrue(runs.some((run) => run.id !== runId && run.status === "queued"));
      yield* leases.control(threadId, Option.none(), runId);
      const waiting = yield* request({ apps: [APP] }, WAIT).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* answer(handoffs, yield* created(), "completed");
      assert.equal((yield* Fiber.join(waiting)).kind, "available");
    }),
  ),
);
