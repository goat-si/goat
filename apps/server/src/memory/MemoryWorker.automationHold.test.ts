import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as AutomationHold from "../automationHold.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Worker from "./MemoryWorker.ts";
import {
  live,
  seed,
  now,
  space,
  environmentId,
  threadId,
  selection,
  id,
} from "./MemoryWorker.testkit.ts";

it.effect(
  "held memory worker leaves catch-up, generation and retry attempts untouched; release resumes them",
  () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const parked = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      let calls = 0;
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        yield* seed;
        const memoryId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
        );
        const store = yield* Store.MemoryStore;
        yield* store.enqueueWork({
          id: "retry",
          space,
          memoryId,
          kind: "summary",
          status: "retry",
          attempt: 2,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
          payloadRef: null,
          metadata: {
            kind: "summary",
            sourceThread: { environmentId, threadId },
            sourceWatermark: {
              fromEventId: M.EventId.make(id(10)),
              toEventId: M.EventId.make(id(11)),
              throughSequence: 2,
            },
            memoryId,
            operationId: M.MemoryOperationId.make(id(4)),
            revisionId: M.MemoryRevisionId.make(id(5)),
            modelSelection: selection,
          },
        });
        const worker = yield* Worker.MemoryWorker;
        yield* worker.start();
        const draining = yield* worker.drain.pipe(
          Effect.tap(() => Deferred.succeed(drained, undefined)),
          Effect.forkScoped,
        );
        yield* Effect.raceFirst(Deferred.await(parked), Deferred.await(drained));
        assert.strictEqual(calls, 0);
        assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
        assert.strictEqual((yield* store.readWork("retry"))?.attempt, 2);
        assert.strictEqual((yield* store.readWork("retry"))?.status, "retry");
        const service = yield* Service.MemoryService;
        const manualId = M.MemoryId.make(id(90));
        yield* service.upsert(
          {
            memorySpaceId: space,
            memoryId: manualId,
            operationId: M.MemoryOperationId.make(id(91)),
            expectedHeads: [],
            scope: { kind: "user" },
            assertionKind: "inference",
            payload: { text: "Explicit user memory", evidence: [], derivedFromMemoryRevisions: [] },
            baseBoundary: null,
          },
          Effect.void,
        );
        const manual = yield* service.read(
          { memorySpaceId: space, memoryId: manualId },
          Effect.void,
        );
        assert.strictEqual(manual.status, "active");
        if (manual.status === "active")
          assert.strictEqual(manual.payload.text, "Explicit user memory");
        assert.strictEqual(calls, 0);
        yield* hold.release;
        yield* Fiber.join(draining);
        assert.isAbove(calls, 0);
        assert.strictEqual(yield* store.readThreadHookWatermark(), 2);
        assert.strictEqual((yield* store.readWork("retry"))?.attempt, 3);
        assert.strictEqual((yield* store.readWork("retry"))?.status, "completed");
      }).pipe(
        Effect.provide(
          live(
            false,
            () => {
              calls++;
            },
            false,
          ),
        ),
        Effect.provideService(AutomationHold.AutomationHold, {
          ...hold,
          awaitRelease: Deferred.succeed(parked, undefined).pipe(Effect.andThen(hold.awaitRelease)),
        }),
      );
    }).pipe(Effect.scoped),
);
