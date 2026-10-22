import { assert, it } from "@effect/vitest";
import { EnvironmentId, RunId, ThreadId, type ThreadResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Results from "../threadResults/ThreadResultService.ts";
import * as NoteResults from "./NoteResults.ts";

const result: ThreadResult = {
  runId: RunId.make("latest-run"),
  runStatus: "running",
  outcome: null,
  reportedAt: null,
  pullRequests: [],
  commits: [],
  branch: null,
};
const link = { threadId: ThreadId.make("worker"), host: null, lastResult: null };
it.effect(
  "enriches local and remote links with their latest run, including running without a report",
  () =>
    Effect.gen(function* () {
      const service = yield* NoteResults.NoteResults;
      assert.deepStrictEqual(yield* service.latest(link), result);
      assert.deepStrictEqual(yield* service.latest({ ...link, host: "host-a" }), result);
      assert.strictEqual(yield* service.latest({ ...link, host: "old-host" }), null);
      yield* service.remember({ ...link, host: "old-host" }, result);
      assert.deepStrictEqual(yield* service.latest({ ...link, host: "old-host" }), result);
      yield* service.remember({ ...link, host: "new-run-host" }, result);
      assert.strictEqual(yield* service.latest({ ...link, host: "new-run-host" }), null);
    }).pipe(
      Effect.provide(
        NoteResults.layer.pipe(
          Layer.provide(
            Layer.mock(Results.ThreadResultService)({
              forRun: (threadId, runId) => {
                assert.strictEqual(threadId, link.threadId);
                assert.strictEqual(runId, undefined);
                return Effect.succeed(result);
              },
              subscribeReports: Effect.succeed(Stream.never),
            }),
          ),
          Layer.provide(
            Layer.mock(Hosts.HostThreadsMcpService)({
              readThread: (scope, input) => {
                assert.strictEqual(scope.thread, undefined);
                assert.strictEqual(input.threadId, link.threadId);
                return Effect.succeed({
                  result:
                    input.host === "old-host" || input.host === "new-run-host" ? null : result,
                  thread: {
                    latestRunId:
                      input.host === "new-run-host" ? RunId.make("new-run") : result.runId,
                  },
                } as never);
              },
            }),
          ),
          Layer.provide(
            Layer.mock(Environment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("hub")),
            }),
          ),
        ),
      ),
    ),
);

it.effect("deduplicates concurrent links and caps remote reads with a two second deadline", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let active = 0;
    let maximum = 0;
    const calls: Array<string> = [];
    yield* Effect.gen(function* () {
      const service = yield* NoteResults.NoteResults;
      const links = Array.from({ length: 10 }, (_, index) => ({ ...link, host: `host-${index}` }));
      const request = yield* Effect.all([...links, links[0]!].map(service.latest), {
        concurrency: "unbounded",
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      assert.strictEqual(active, 4);
      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(yield* Fiber.join(request), Array(11).fill(null));
      assert.strictEqual(maximum, 4);
      assert.strictEqual(calls.filter((host) => host === "host-0").length, 1);
      assert.strictEqual(active, 0);
    }).pipe(
      Effect.provide(
        NoteResults.layer.pipe(
          Layer.provide(
            Layer.mock(Results.ThreadResultService)({
              subscribeReports: Effect.succeed(Stream.never),
            }),
          ),
          Layer.provide(
            Layer.mock(Hosts.HostThreadsMcpService)({
              readThread: (_scope, input) =>
                Effect.gen(function* () {
                  assert.isDefined(input.host);
                  calls.push(input.host!);
                  yield* Effect.acquireRelease(
                    Effect.sync(() => {
                      active++;
                      maximum = Math.max(maximum, active);
                    }),
                    () =>
                      Effect.sync(() => {
                        active--;
                      }),
                  );
                  if (active === 4) yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                  return { result: null, thread: { latestRunId: null } } as never;
                }).pipe(Effect.scoped),
            }),
          ),
          Layer.provide(
            Layer.mock(Environment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("hub")),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("a terminal local event does not reuse a lookup started before that event", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const completed: ThreadResult = { ...result, runStatus: "completed", outcome: "succeeded" };
    yield* Effect.gen(function* () {
      const service = yield* NoteResults.NoteResults;
      const first = yield* service.latest(link).pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
        Effect.andThen(service.latest(link)),
        Effect.forkScoped,
      );
      yield* Deferred.await(secondStarted);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(first), result);
      assert.deepStrictEqual(yield* Fiber.join(second), completed);
      assert.strictEqual(calls, 2);
    }).pipe(
      Effect.provide(
        NoteResults.layer.pipe(
          Layer.provide(
            Layer.mock(Results.ThreadResultService)({
              subscribeReports: Effect.succeed(Stream.never),
              forRun: () =>
                Effect.gen(function* () {
                  calls++;
                  if (calls > 1) return completed;
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(release);
                  return result;
                }),
            }),
          ),
          Layer.provide(Layer.mock(Hosts.HostThreadsMcpService)({})),
          Layer.provide(
            Layer.mock(Environment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("hub")),
            }),
          ),
        ),
      ),
    );
  }),
);
