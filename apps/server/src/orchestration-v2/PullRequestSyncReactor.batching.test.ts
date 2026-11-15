import { assert, describe, it } from "@effect/vitest";
import { PullRequestOperationError, type PullRequestRef } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import * as PullRequestSyncReactor from "./PullRequestSyncReactor.ts";
import {
  NOW,
  makeHarness,
  makeLink,
  makeSnapshot,
  makeSummary,
  makeThread,
  startAndSweep,
} from "./testkit/pullRequestSync.fixture.ts";

const stackLayer = (number: number) => ({
  number,
  headBranch: `layer-${number}`,
  state: "open" as const,
});

describe("PullRequestSyncReactor batching", () => {
  it.effect("reads hosts that batch all at once and other hosts at the old sweep width", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const numbers = Array.from({ length: 60 }, (_, index) => index + 1);
        const hostOf = (number: number) => (number <= 30 ? "github.com" : "gitlab.example.com");
        const batches = (input: PullRequestRef) => input.host === "github.com";
        const batched = yield* Ref.make(0);
        const unbatched = yield* Ref.make(0);
        const started = yield* Queue.unbounded<void>();
        const release = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            numbers.map((number) =>
              makeThread(`thread-${number}`, {
                pullRequests: [makeLink(number, null, { host: hostOf(number) })],
              }),
            ),
          ),
          batchesReads: batches,
          summary: (input) => {
            const inFlight = batches(input) ? batched : unbatched;
            return Ref.update(inFlight, (count) => count + 1).pipe(
              Effect.andThen(Queue.offer(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Ref.update(inFlight, (count) => count - 1)),
              Effect.as(makeSummary(input)),
            );
          },
        });
        yield* Effect.gen(function* () {
          const reactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.takeN(started, 25);
          yield* TestClock.adjust(0);
          assert.strictEqual(yield* Ref.get(batched), 30);
          assert.strictEqual(yield* Ref.get(unbatched), 25);
          yield* Deferred.succeed(release, undefined);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, numbers.length);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reads a member a sibling flags while the sweep is full", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stackOf = (layers: ReadonlyArray<number>) => ({
          id: "9",
          number: 9,
          url: "https://github.com/owner/repository/stack/9",
          base: "main",
          layers: layers.map(stackLayer),
        });
        // #50 is merged and not due until #1's stack read shows it a different layer list.
        const merged = makeLink(
          50,
          { state: "merged", mergedAt: NOW },
          { stack: { kind: "native", ...stackOf([50]) } },
        );
        const started = yield* Ref.make(0);
        const full = yield* Deferred.make<void>();
        const synced1 = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            // Another host takes 24 of the 25 shared slots and #1 the last one.
            ...Array.from({ length: 24 }, (_, index) =>
              makeThread(`thread-${index + 2}`, {
                pullRequests: [makeLink(index + 2, null, { host: "gitlab.example.com" })],
              }),
            ),
            makeThread("thread-1", { pullRequests: [makeLink(1)] }),
            makeThread("thread-50", { pullRequests: [merged] }),
          ]),
          batchesReads: () => false,
          // #1 reads once all 25 slots are taken; the other 24 hold theirs until #1 has synced.
          summary: (input) =>
            Ref.updateAndGet(started, (count) => count + 1).pipe(
              // Forked, so #1 resumes only after the sweep has handed out its next slot.
              Effect.tap((count) =>
                count === 25 ? Effect.forkChild(Deferred.succeed(full, undefined)) : Effect.void,
              ),
              Effect.andThen(
                input.number === 50
                  ? Effect.void
                  : Deferred.await(input.number === 1 ? full : synced1),
              ),
              Effect.as(makeSummary(input)),
            ),
          stack: (input) => Effect.succeed(input.number === 1 ? stackOf([1, 50]) : null),
          onSync: (command) =>
            command.number === 1 ? Deferred.succeed(synced1, undefined) : Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);
          const read = (yield* Ref.get(fixture.summaryCalls)).map((ref) => ref.number);
          assert.include(read, 50);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reports provider resolution failures and continues other hosts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const messages: Array<unknown> = [];
        const logger = Logger.make(({ message }) => messages.push(message));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("bad", { pullRequests: [makeLink(1, null, { host: "bad.example" })] }),
            makeThread("good", { pullRequests: [makeLink(2)] }),
          ]),
          batchesReadsError: (input) =>
            input.host === "bad.example"
              ? new PullRequestOperationError({ operation: "resolve", detail: "unavailable" })
              : undefined,
        });
        yield* Effect.gen(function* () {
          yield* startAndSweep(fixture);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls)).map((ref) => ref.number),
            [2],
          );
          assert.include(JSON.stringify(messages), "PullRequestOperationError");
        }).pipe(
          Effect.provide(
            fixture.layer.pipe(
              Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: true })),
            ),
          ),
        );
      }),
    ),
  );
});
