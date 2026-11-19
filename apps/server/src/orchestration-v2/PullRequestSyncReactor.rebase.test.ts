import { ThreadId, type PullRequestSummary } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import {
  makeHarness,
  makeLink,
  makeSnapshot,
  makeSummary,
  makeThread,
  startAndSweep,
} from "./testkit/pullRequestSync.fixture.ts";

it.effect(
  "a same-timestamp rebase change syncs while an unknown read preserves the prior value",
  () =>
    Effect.gen(function* () {
      const thread = ThreadId.make("rebase-sync");
      let rebaseRequired: boolean | undefined;
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([
          makeThread(thread, { pullRequests: [makeLink(7, { rebaseRequired: true })] }),
        ]),
        summary: (input) =>
          Effect.succeed({
            ...makeSummary(input),
            ...(rebaseRequired === undefined ? {} : { rebaseRequired }),
          } satisfies PullRequestSummary),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* startAndSweep(fixture);
        assert.lengthOf(yield* Ref.get(fixture.syncCommands), 0);
        rebaseRequired = false;
        yield* reactor.requestSync({
          host: "github.com",
          repository: "owner/repository",
          number: 7,
        });
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        const commands = yield* Ref.get(fixture.syncCommands);
        assert.lengthOf(commands, 1);
        assert.isFalse(commands[0]!.snapshot.rebaseRequired);
      }).pipe(Effect.provide(fixture.layer));
    }),
);
