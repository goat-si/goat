import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as PullRequestSyncReactor from "./PullRequestSyncReactor.ts";
import {
  NOW,
  makeHarness,
  makeSnapshot,
  makeThread,
  makeLink,
  makeSummary,
} from "./testkit/pullRequestSync.fixture.ts";

it.effect("leaves a forge CLI slot for reads outside the sweep", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const asked = yield* Queue.unbounded<void>();
    const started = yield* Queue.unbounded<string>();
    const release = yield* Deferred.make<void>();
    const vcs = yield* VcsProcess.make.pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Queue.offer(started, input.args.at(-1)!).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                stdout: "",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
            ),
        }),
      ),
    );
    const glab = (number: string) =>
      vcs.run({
        operation: "synthetic.glab.view",
        command: "glab",
        args: ["mr", "view", number],
        cwd: "/workspace",
      });
    const numbers = Array.from({ length: 6 }, (_, index) => index + 1);
    const fixture = yield* makeHarness({
      snapshot: makeSnapshot(
        numbers.map((number) =>
          makeThread(`thread-${number}`, {
            pullRequests: [makeLink(number, null, { host: "gitlab.example.com" })],
          }),
        ),
      ),
      batchesReads: () => false,
      summary: (input) =>
        Queue.offer(asked, undefined).pipe(
          Effect.andThen(glab(String(input.number))),
          Effect.orDie,
          Effect.as(makeSummary(input)),
        ),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* reactor.start();
      yield* Deferred.succeed(fixture.activation, undefined);
      yield* Queue.takeN(asked, numbers.length);
      yield* Queue.takeN(started, 3);
      const panel = yield* glab("panel").pipe(Effect.forkChild({ startImmediately: true }));
      assert.strictEqual(yield* Queue.take(started), "panel");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(panel);
      yield* reactor.drain;
      assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, numbers.length);
    }).pipe(Effect.provide(fixture.layer));
  }),
);
