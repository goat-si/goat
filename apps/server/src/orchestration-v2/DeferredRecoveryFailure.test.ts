import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { makeDeferredRecoveryResends } from "./goat/DeferredRecoveryResends.ts";

it.effect(
  "a failing candidate does not stop later candidates and can be recovered on restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = makeLocalCommandHarness({ text: "Work" }).projection();
        const ids = yield* IdAllocator.IdAllocatorV2;
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const sent: string[] = [];
        const logs: unknown[] = [];
        let healthy = false;
        const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.provide(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getTurnStartContext: (threadId) => {
                if (!healthy && threadId === ThreadId.make("failure-read"))
                  return Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "injected read failure",
                    }),
                  );
                const run = {
                  ...base.runs[0]!,
                  id: RunId.make(`run:${threadId}`),
                  threadId,
                  status: "starting" as const,
                };
                return Effect.succeed({
                  ...base,
                  thread: { ...base.thread, id: threadId },
                  runs: [run],
                  attempts: [
                    { ...base.attempts[0]!, runId: run.id, inputDelivery: "unsent" as const },
                  ],
                  nodes: [{ ...base.nodes[0]!, runId: run.id }],
                  providerTurns: [],
                  hasConversation: true,
                });
              },
            }),
          ),
        );
        const sink = yield* EventSink.EventSinkV2.pipe(
          Effect.provide(
            Layer.mock(EventSink.EventSinkV2)({
              latestSequence: () => Effect.succeed(1),
              writeIfRunCurrent: (input) =>
                !healthy && input.threadId === ThreadId.make("failure-write")
                  ? Effect.fail(
                      new EventSink.EventSinkWriteError({
                        eventCount: 0,
                        cause: "injected write failure",
                      }),
                    )
                  : Effect.sync(() => {
                      sent.push(input.threadId);
                      return { committed: true, storedEvents: [] };
                    }),
            }),
          ),
        );
        const stage = (names: string[]) =>
          Effect.gen(function* () {
            const deferred = makeDeferredRecoveryResends({ projections, sink, ids });
            for (const name of names) {
              const threadId = ThreadId.make(name);
              const run = {
                ...base.runs[0]!,
                id: RunId.make(`run:${name}`),
                threadId,
                status: "starting" as const,
              };
              expect(
                deferred.reserve({
                  threadId,
                  run,
                  attemptId: base.attempts[0]!.id,
                  commandId: CommandId.make(`command:${name}`),
                  resendCount: 0,
                }),
              ).toBe(true);
              yield* deferred.captureSequence(threadId);
            }
            yield* deferred.drain(locks);
          });
        const logger = Logger.make(({ message }) => {
          logs.push(message);
        });
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        yield* gate.signalCommandReady;
        yield* stage(["failure-read", "failure-write", "healthy"]).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
        expect(sent).toEqual(["healthy"]);
        expect(yield* gate.enqueueCommand(Effect.succeed("command handled"))).toBe(
          "command handled",
        );
        expect(
          logs.filter(
            (message) => Array.isArray(message) && message[0] === "Deferred recovery start failed",
          ),
        ).toHaveLength(2);
        expect(
          logs
            .filter(
              (message) =>
                Array.isArray(message) && message[0] === "Deferred recovery start failed",
            )
            .map((message) => (Array.isArray(message) ? message[1] : undefined)),
        ).toMatchObject([
          {
            threadId: "failure-read",
            runId: "run:failure-read",
            errorTag: "ProjectionStoreReadError",
          },
          {
            threadId: "failure-write",
            runId: "run:failure-write",
            errorTag: "EventSinkWriteError",
          },
        ]);
        healthy = true;
        yield* stage(["failure-read", "failure-write"]);
        expect(sent).toEqual(["healthy", "failure-read", "failure-write"]);
      }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, ThreadCommandExecutor.layer))),
    ),
);

it.effect("interrupting the drain does not process later candidates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = makeLocalCommandHarness({ text: "Work" }).projection();
      const ids = yield* IdAllocator.IdAllocatorV2;
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const entered = yield* Deferred.make<void>();
      const reads: string[] = [];
      const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getTurnStartContext: (threadId) =>
              Effect.sync(() => {
                reads.push(threadId);
              }).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never),
              ),
          }),
        ),
      );
      const sink = yield* EventSink.EventSinkV2.pipe(
        Effect.provide(
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Effect.succeed(1),
          }),
        ),
      );
      const deferred = makeDeferredRecoveryResends({ projections, sink, ids });
      for (const name of ["first", "second"]) {
        const threadId = ThreadId.make(name);
        const run = {
          ...base.runs[0]!,
          id: RunId.make(`run:${name}`),
          threadId,
          status: "starting" as const,
        };
        deferred.reserve({
          threadId,
          run,
          attemptId: base.attempts[0]!.id,
          commandId: CommandId.make(`command:${name}`),
          resendCount: 0,
        });
        yield* deferred.captureSequence(threadId);
      }
      const fiber = yield* deferred
        .drain(locks)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(reads).toEqual(["first"]);
    }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, ThreadCommandExecutor.layer))),
  ),
);
