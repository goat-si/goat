import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

const unusedRuntimeMethod = () =>
  Effect.fail(
    new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "unused",
      detail: "unused test method",
    }),
  );

const makeRuntime = Effect.gen(function* () {
  const starts = yield* Ref.make(0);
  const closes = yield* Ref.make(0);
  const failNextStart = yield* Ref.make(false);
  const started = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
    startOpenCodeServerProcess: () =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(failNextStart, false)) {
          return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail: "start failed",
          });
        }
        const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
        yield* Deferred.succeed(started, undefined).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() =>
          Ref.update(closes, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.ignore,
          ),
        );
        return {
          url: `http://127.0.0.1:${index}`,
          version: "1.14.19",
          isRunning: Effect.succeed(true),
          exitCode: Effect.never,
        };
      }),
    connectToOpenCodeServer: unusedRuntimeMethod,
    runOpenCodeCommand: unusedRuntimeMethod,
    createOpenCodeSdkClient: () => ({}) as never,
    loadOpenCodeInventory: unusedRuntimeMethod,
    loadOpenCodeSkills: unusedRuntimeMethod,
    loadInventoryFromCli: unusedRuntimeMethod,
    loadSkillsFromCli: unusedRuntimeMethod,
  };
  return { runtime, starts, closes, failNextStart, started, closed };
});

it.effect("shares concurrent borrowers and closes after the idle TTL", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const release = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        const useServer = owner.withServer((server) =>
          Deferred.await(release).pipe(Effect.as(server.url)),
        );
        const fibers = yield* Effect.all([useServer, useServer], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(testRuntime.started);
        expect(yield* Ref.get(testRuntime.starts)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(fibers)).toEqual(["http://127.0.0.1:1", "http://127.0.0.1:1"]);
        yield* TestClock.adjust(Duration.seconds(31));
        yield* Deferred.await(testRuntime.closed);
        expect(yield* Ref.get(testRuntime.closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, testRuntime.runtime));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps a borrowed server through owner shutdown and stops it when the borrows end", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const release = yield* Deferred.make<void>();
    const ownerScope = yield* Scope.make();
    const owner = yield* OpenCodeServerOwner.make({
      binaryPath: "opencode",
      directory: "/project",
    }).pipe(
      Scope.provide(ownerScope),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, testRuntime.runtime),
    );
    const borrower = yield* owner
      .withServer((server) => Deferred.await(release).pipe(Effect.as(server.url)))
      .pipe(Effect.forkChild);
    yield* Deferred.await(testRuntime.started);

    yield* Scope.close(ownerScope, Exit.void);
    expect(yield* Ref.get(testRuntime.closes)).toBe(0);
    // A session reconnecting its event stream borrows again before releasing; it reattaches.
    expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
      "http://127.0.0.1:1",
    );
    expect(yield* Ref.get(testRuntime.starts)).toBe(1);

    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(borrower)).toBe("http://127.0.0.1:1");
    // No clock adjustment: the stop must not wait for the idle TTL.
    yield* Deferred.await(testRuntime.closed);
    expect(yield* Ref.get(testRuntime.closes)).toBe(1);
    const refused = yield* Effect.exit(owner.withServer((server) => Effect.succeed(server.url)));
    expect(refused._tag).toBe("Failure");
    expect(yield* Ref.get(testRuntime.starts)).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("retries a failed start and closes on owner scope shutdown", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    yield* Ref.set(testRuntime.failNextStart, true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        expect(
          (yield* Effect.exit(owner.withServer((server) => Effect.succeed(server.url))))._tag,
        ).toBe("Failure");
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:1",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, testRuntime.runtime));
    expect(yield* Ref.get(testRuntime.starts)).toBe(1);
    expect(yield* Ref.get(testRuntime.closes)).toBe(1);
  }),
);

it.effect("replaces a dead cached process before its exit watcher runs", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const closes = yield* Ref.make(0);
    const processRunning: Array<Ref.Ref<boolean>> = [];
    const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          const isRunning = yield* Ref.make(true);
          processRunning.push(isRunning);
          yield* Effect.addFinalizer(() => Ref.update(closes, (count) => count + 1));
          return {
            url: `http://127.0.0.1:${index}`,
            version: "1.14.19",
            isRunning: Ref.get(isRunning),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:1",
        );
        yield* Ref.set(processRunning[0]!, false);

        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:2",
        );
        expect(yield* Ref.get(starts)).toBe(2);
        expect(yield* Ref.get(closes)).toBe(1);
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
  }),
);

it.effect("cleans up an interrupted startup and allows a retry", () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0);
    const firstStartEntered = yield* Deferred.make<void>();
    const firstStartClosed = yield* Deferred.make<void>();
    const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
      startOpenCodeServerProcess: () =>
        Effect.gen(function* () {
          const index = yield* Ref.updateAndGet(starts, (count) => count + 1);
          yield* Effect.addFinalizer(() =>
            index === 1
              ? Deferred.succeed(firstStartClosed, undefined).pipe(Effect.ignore)
              : Effect.void,
          );
          if (index === 1) {
            yield* Deferred.succeed(firstStartEntered, undefined);
            return yield* Effect.never;
          }
          return {
            url: `http://127.0.0.1:${index}`,
            version: "1.14.19",
            isRunning: Effect.succeed(true),
            exitCode: Effect.never,
          };
        }),
      connectToOpenCodeServer: unusedRuntimeMethod,
      runOpenCodeCommand: unusedRuntimeMethod,
      createOpenCodeSdkClient: () => ({}) as never,
      loadOpenCodeInventory: unusedRuntimeMethod,
      loadOpenCodeSkills: unusedRuntimeMethod,
      loadInventoryFromCli: unusedRuntimeMethod,
      loadSkillsFromCli: unusedRuntimeMethod,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: "opencode",
          directory: "/project",
        });
        const firstBorrower = yield* owner
          .withServer((server) => Effect.succeed(server.url))
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStartEntered);
        yield* Fiber.interrupt(firstBorrower);
        yield* Deferred.await(firstStartClosed);
        expect(yield* owner.withServer((server) => Effect.succeed(server.url))).toBe(
          "http://127.0.0.1:2",
        );
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
  }),
);

it.effect(
  "starts a separate server for a new environment while retaining the borrowed server",
  () =>
    Effect.gen(function* () {
      const testRuntime = yield* makeRuntime;
      const host = { PATH: "/old" };
      const release = yield* Deferred.make<void>();
      const firstReady = yield* Deferred.make<string>();
      const starts: string[] = [];
      const runtime = {
        ...testRuntime.runtime,
        startOpenCodeServerProcess: (
          input: Parameters<typeof testRuntime.runtime.startOpenCodeServerProcess>[0],
        ) =>
          Effect.sync(() => {
            starts.push(input.environment?.PATH ?? "");
          }).pipe(Effect.andThen(testRuntime.runtime.startOpenCodeServerProcess(input))),
      };
      const owner = yield* OpenCodeServerOwner.make({
        binaryPath: "opencode",
        directory: "/project",
        currentEnvironment: Effect.sync(() => ({ ...host })),
      }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
      const first = yield* owner
        .withServer((server) =>
          Deferred.succeed(firstReady, server.url).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(server.url),
          ),
        )
        .pipe(Effect.forkScoped);
      const firstUrl = yield* Deferred.await(firstReady);
      host.PATH = "/new";
      const secondUrl = yield* owner.withServer((server) => Effect.succeed(server.url));
      expect(secondUrl).not.toBe(firstUrl);
      expect(starts).toEqual(["/old", "/new"]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe(firstUrl);
    }).pipe(Effect.scoped),
);

it.effect("restarts a session using its captured environment and executable", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const host = { PATH: "/old" };
    let executable = "/old/opencode";
    const running: Array<Ref.Ref<boolean>> = [];
    const starts: Array<{ path: string | undefined; executable: string }> = [];
    const runtime = {
      ...testRuntime.runtime,
      startOpenCodeServerProcess: (
        input: Parameters<typeof testRuntime.runtime.startOpenCodeServerProcess>[0],
      ) =>
        Effect.gen(function* () {
          starts.push({ path: input.environment?.PATH, executable: input.binaryPath });
          const alive = yield* Ref.make(true);
          running.push(alive);
          const server = yield* testRuntime.runtime.startOpenCodeServerProcess(input);
          return { ...server, isRunning: Ref.get(alive) };
        }),
    };
    const owner = yield* OpenCodeServerOwner.make({
      binaryPath: "opencode",
      directory: "/project",
      currentEnvironment: Effect.sync(() => host),
    }).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
      Effect.provideService(SpawnExecutableResolution, () => executable),
    );
    const launch = yield* owner.captureLaunch;
    const first = yield* owner.withServer((server) => Effect.succeed(server.url), launch);
    host.PATH = "/new";
    executable = "/new/opencode";
    yield* Ref.set(running[0]!, false);
    const replacement = yield* owner.withServer((server) => Effect.succeed(server.url), launch);
    expect(replacement).not.toBe(first);
    expect(starts).toEqual([
      { path: "/old", executable: "/old/opencode" },
      { path: "/old", executable: "/old/opencode" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("bounds idle environment-specific servers by closing the oldest idle entry", () =>
  Effect.gen(function* () {
    const testRuntime = yield* makeRuntime;
    const host = { PATH: "/fixture", PROFILE: "0" };
    const owner = yield* OpenCodeServerOwner.make({
      binaryPath: "opencode",
      directory: "/project",
      currentEnvironment: Effect.sync(() => host),
    }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, testRuntime.runtime));
    for (let i = 0; i < 33; i++) {
      host.PROFILE = String(i);
      yield* owner.withServer(() => Effect.void);
    }
    expect(yield* Ref.get(testRuntime.starts)).toBe(33);
    expect(yield* Ref.get(testRuntime.closes)).toBe(1);
  }).pipe(Effect.scoped),
);
