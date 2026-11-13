import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as OriginCli from "./OriginCli.ts";
import * as OriginPullRequestProvider from "./OriginPullRequestProvider.ts";

const pullRequest = { cwd: "/repo", repository: "acme/app", host: "cursor.com", number: 7 };

type CheckReason = OriginCli.OriginCliError["reason"];

/** Origin as seen by the provider: the pull request's head, and a check-run answer per commit. */
const makeProvider = Effect.fnUntraced(function* (origin: {
  head: string;
  refusedChecks: Map<string, CheckReason>;
  checkReads: Array<string>;
}) {
  const answer = (input: Parameters<OriginCli.OriginCli["Service"]["api"]>[0]) => {
    if (input.operation === "getPullRequest")
      return Effect.succeed({
        number: 7,
        title: "Change",
        webUrl: "https://cursor.com/acme/app/pull/7",
        head: { ref: "feature", sha: origin.head },
        base: { ref: "main", sha: "base-sha" },
      });
    const sha = /\/commits\/([^/]+)\/check-runs/.exec(input.path)?.[1] ?? "";
    origin.checkReads.push(sha);
    const reason = origin.refusedChecks.get(sha);
    return reason === undefined
      ? Effect.succeed({
          checkRuns: [{ name: "build " + sha, status: "completed", conclusion: "success" }],
        })
      : Effect.fail(
          new OriginCli.OriginCliError({
            operation: input.operation,
            cwd: input.cwd,
            detail: reason,
            reason,
          }),
        );
  };
  const provider = yield* OriginPullRequestProvider.make.pipe(
    Effect.provideService(
      OriginCli.OriginCli,
      OriginCli.OriginCli.of({
        api: (input) => answer(input) as never,
        execute: () => Effect.die("unused execute"),
        viewer: () => Effect.die("unused viewer"),
        personalNamespace: () => Effect.die("unused personalNamespace"),
        resolveRepository: () => Effect.die("unused resolveRepository"),
      }),
    ),
  );
  const readChecks = provider.getChangeRequestChecks;
  assert.isDefined(readChecks);
  return readChecks;
});

describe("OriginPullRequestProvider checks read", () => {
  it.effect(
    "regression: an obsolete early read refused for sign-in does not fail the fresh read",
    () =>
      Effect.gen(function* () {
        const origin = {
          head: "old-sha",
          refusedChecks: new Map<string, CheckReason>(),
          checkReads: [] as Array<string>,
        };
        const readChecks = yield* makeProvider(origin);
        yield* readChecks(pullRequest);

        // The head moved, and the early read from the old head is refused.
        origin.head = "new-sha";
        origin.refusedChecks.set("old-sha", "unauthenticated");
        yield* TestClock.adjust("2 seconds");
        const fresh = yield* readChecks(pullRequest);
        assert.deepStrictEqual(
          fresh.checks.map((check) => check.name),
          ["build new-sha"],
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "contract: a same-basis early read refused for rate limit fails without asking again",
    () =>
      Effect.gen(function* () {
        const origin = {
          head: "same-sha",
          refusedChecks: new Map<string, CheckReason>(),
          checkReads: [] as Array<string>,
        };
        const readChecks = yield* makeProvider(origin);
        yield* readChecks(pullRequest);

        origin.refusedChecks.set("same-sha", "rate-limited");
        origin.checkReads.length = 0;
        yield* TestClock.adjust("2 seconds");
        const error = yield* Effect.flip(readChecks(pullRequest));
        assert.strictEqual(error.reason, "rate-limited");
        assert.deepStrictEqual(origin.checkReads, ["same-sha"]);
      }).pipe(Effect.scoped),
  );
});
