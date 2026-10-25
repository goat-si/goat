import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AutomationHold from "../automationHold.ts";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Auto from "./NoteAutoDone.ts";
import * as Notes from "./NotesService.ts";
import { notesLayer } from "./NotesTestkit.ts";

it.effect(
  "held notes acquire without remote reconciliation or followers; release resumes both and user reads work",
  () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const parked = yield* Deferred.make<void>();
      const readStarted = yield* Deferred.make<void>();
      const followed = yield* Deferred.make<void>();
      const reconciled = yield* Deferred.make<void>();
      let reads = 0;
      let observeReads = false;
      let waits = 0;
      yield* Effect.gen(function* () {
        const notes = yield* Notes.NotesService;
        yield* notes.write({ path: "held.md", body: "work", baseRevision: null }, "user");
        yield* notes.link("held.md", {
          threadId: ThreadId.make("remote"),
          host: "other",
          lastResult: null,
        });
        reads = 0;
        observeReads = true;
        const context = yield* Layer.build(
          Auto.layer.pipe(
            Layer.provide(
              Layer.mock(Hosts.HostThreadsMcpService)({
                waitForThread: () =>
                  Effect.sync(() => {
                    waits++;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(followed, undefined)),
                    Effect.andThen(Effect.never),
                  ),
              }),
            ),
            Layer.provide(
              Layer.mock(Sink.EventSinkV2)({ latestSequence: () => Effect.succeed(0) }),
            ),
            Layer.provide(
              Layer.mock(Orchestrator.OrchestratorV2)({
                streamStoredEventsFrom: () => Stream.never,
              }),
            ),
          ),
        );
        yield* Effect.raceFirst(Deferred.await(parked), Deferred.await(readStarted));
        assert.strictEqual(reads, 0);
        assert.strictEqual(waits, 0);
        assert.strictEqual((yield* notes.read({ path: "held.md" })).body, "work");
        assert.strictEqual(reads, 1);
        yield* Context.get(context, Auto.NoteAutoDone).reconcileNote("held.md");
        assert.strictEqual(reads, 2);
        assert.strictEqual(waits, 0);
        yield* hold.release;
        yield* Deferred.await(followed);
        yield* Deferred.await(reconciled);
        assert.isAbove(reads, 2);
        assert.strictEqual(waits, 1);
      }).pipe(
        Effect.provide(
          notesLayer(() =>
            Effect.sync(() => {
              reads++;
              return null;
            }).pipe(
              Effect.tap(() =>
                observeReads ? Deferred.succeed(readStarted, undefined) : Effect.void,
              ),
              Effect.tap(() => (reads > 2 ? Deferred.succeed(reconciled, undefined) : Effect.void)),
            ),
          ),
        ),
        Effect.provideService(AutomationHold.AutomationHold, {
          ...hold,
          awaitRelease: Deferred.succeed(parked, undefined).pipe(Effect.andThen(hold.awaitRelease)),
        }),
      );
    }).pipe(Effect.scoped),
);
