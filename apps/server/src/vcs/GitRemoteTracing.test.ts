import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("Git remote tracing", (it) => {
  it.effect("records no failed span reading status of a repository without a remote", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const traced = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          spans.length = 0;
          const exit = yield* effect.pipe(Effect.withTracer(tracer), Effect.exit);
          const failedSpans = spans.flatMap((span) =>
            span.status._tag === "Ended" && Exit.isFailure(span.status.exit) ? [span.name] : [],
          );
          return { exit, failedSpans };
        });

      const status = yield* traced(driver.statusDetailsRemote(cwd));
      assert.isTrue(Exit.isSuccess(status.exit));
      assert.deepStrictEqual(status.failedSpans, []);

      const fetch = yield* traced(driver.fetchRefCommit({ cwd, ref: "refs/pull/1/head" }));
      assert.include(
        Exit.isFailure(fetch.exit) ? Cause.pretty(fetch.exit.cause) : "",
        "No git remote is configured for this repository.",
      );
      assert.deepStrictEqual(fetch.failedSpans, ["GitVcsDriver.fetchRefCommit"]);
    }),
  );
});
