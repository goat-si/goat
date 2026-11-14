import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type OrchestrationV2ThreadProjection } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

it.effect(
  "admits two transcript exports at a time and frees a slot on failure or interruption",
  () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const gates = new Map(
        ["a", "b", "c", "d", "e", "f"].map((id) => [
          id,
          Deferred.makeUnsafe<void, Orchestrator.OrchestratorV2Error>(),
        ]),
      );
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadSnapshot: (threadId) =>
              Queue.offer(started, threadId).pipe(
                Effect.andThen(Deferred.await(gates.get(threadId)!)),
                Effect.as({
                  schemaVersion: 1,
                  snapshotSequence: 1,
                  projection: {
                    thread: { id: threadId, title: threadId },
                    updatedAt: DateTime.makeUnsafe(0),
                    visibleTurnItems: [],
                  } as unknown as OrchestrationV2ThreadProjection,
                }),
              ),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );

      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const exportThread = (id: string) =>
          threads.getThreadTranscript(ThreadId.make(id)).pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:export")),
            }),
            Effect.forkChild({ startImmediately: true }),
          );
        const a = yield* exportThread("a");
        const b = yield* exportThread("b");
        const c = yield* exportThread("c");
        const d = yield* exportThread("d");
        const e = yield* exportThread("e");
        const f = yield* exportThread("f");
        expect(yield* Queue.takeAll(started)).toEqual(["a", "b"]);

        yield* Fiber.interrupt(c);
        yield* Deferred.fail(
          gates.get("a")!,
          new Orchestrator.OrchestratorProjectionError({ threadId: ThreadId.make("a"), cause: "" }),
        );
        expect(yield* Queue.take(started)).toBe("d");
        yield* Fiber.interrupt(b);
        expect(yield* Queue.take(started)).toBe("e");
        yield* Deferred.succeed(gates.get("d")!, undefined);
        expect(yield* Queue.take(started)).toBe("f");
        yield* Deferred.succeed(gates.get("e")!, undefined);
        yield* Deferred.succeed(gates.get("f")!, undefined);

        expect((yield* Fiber.await(a))._tag).toBe("Failure");
        expect((yield* Fiber.join(d)).threadId).toBe("d");
        expect((yield* Fiber.join(e)).threadId).toBe("e");
        expect((yield* Fiber.join(f)).threadId).toBe("f");
        expect(yield* Queue.size(started)).toBe(0);
      }).pipe(Effect.provide(layerTest));
    }),
);
