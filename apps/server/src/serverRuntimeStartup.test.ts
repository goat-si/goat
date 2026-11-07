import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as DesktopStopIntentReader from "./desktopStopIntent.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { bootstrapScenario } from "./serverRuntimeStartup.testkit.ts";

it.effect("waits for the HTTP listener and routes before legacy import and recovery", () =>
  Effect.gen(function* () {
    const settings = yield* Deferred.make<void>();
    const auxiliary = yield* Deferred.make<void>();
    yield* bootstrapScenario("disabled-codex", Effect.void, { log: [], settings, auxiliary });
  }),
);

it.effect.each(["disabled-codex", "project-failure"] as const)(
  "desktop startup heartbeat stops after %s",
  (scenario) =>
    Effect.gen(function* () {
      const settings = yield* Deferred.make<void>();
      const auxiliary = yield* Deferred.make<void>();
      const messages: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const checkHeartbeat = Effect.gen(function* () {
        yield* TestClock.adjust("30 seconds");
        const heartbeats = messages.filter(
          (message) => Array.isArray(message) && message[0] === "Server still starting",
        );
        assert.equal(heartbeats.length, 2);
        assert.deepStrictEqual(
          heartbeats.map((message) => (Array.isArray(message) ? message[1]?.elapsedMs : undefined)),
          [15000, 30000],
        );
        assert.isTrue(
          heartbeats.every(
            (message) =>
              Array.isArray(message) && message[1]?.phase === "waiting for http listener",
          ),
        );
      });
      const checkStopped = Effect.gen(function* () {
        const count = messages.filter(
          (message) => Array.isArray(message) && message[0] === "Server still starting",
        ).length;
        yield* TestClock.adjust("30 seconds");
        assert.equal(
          messages.filter(
            (message) => Array.isArray(message) && message[0] === "Server still starting",
          ).length,
          count,
        );
      });
      yield* bootstrapScenario(scenario, Effect.void, {
        log: [],
        settings,
        auxiliary,
        checkHeartbeat,
        checkStopped,
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      const count = messages.length;
      yield* TestClock.adjust("30 seconds");
      assert.equal(messages.length, count);
    }),
);

it.effect.each([
  "disabled-codex",
  "disabled-default",
  "launch-failure",
  "project-failure",
] as const)("keeps bootstrap launch failures separate from project failures: %s", (scenario) =>
  bootstrapScenario(scenario),
);

it.effect.each(["relaunch", "unknown"] as const)("records shutdown intent: %s", (reason) =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const intent =
      reason === "relaunch"
        ? Option.some({
            version: 1 as const,
            pid: 123,
            reason: "relaunch" as const,
            requestedAt: "2026-01-01T00:00:00Z",
          })
        : Option.none();
    yield* bootstrapScenario("disabled-codex", Effect.void, undefined, intent).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    assert.isTrue(
      messages.some(
        (message) =>
          Array.isArray(message) &&
          message[0] === "Server shutdown intent" &&
          message[1]?.reason === reason &&
          message[1]?.requestedAt === (reason === "relaunch" ? "2026-01-01T00:00:00Z" : undefined),
      ),
    );
  }),
);

it.effect("an interrupted startup fiber logs the relaunch intent from the file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = (yield* Path.Path).join(yield* fs.makeTempDirectoryScoped(), "intent.json");
    yield* fs.writeFileString(
      path,
      JSON.stringify({
        version: 1,
        pid: 123,
        reason: "relaunch",
        requestedAt: "2026-01-01T00:00:00Z",
      }),
    );
    const ready = yield* Deferred.make<void>();
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    yield* Effect.gen(function* () {
      const reader = yield* DesktopStopIntentReader.DesktopStopIntentReader;
      const fiber = yield* bootstrapScenario(
        "disabled-codex",
        Effect.void,
        undefined,
        Option.none(),
        reader.atShutdown,
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(
        messages.some(
          (message) =>
            Array.isArray(message) &&
            message[0] === "Server shutdown intent" &&
            message[1]?.reason === "relaunch",
        ),
      );
    }).pipe(Effect.provide(DesktopStopIntentReader.layer(path, 123)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an interrupted startup bounds a stalled intent read to one second", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const fs = FileSystem.layerNoop({
      stream: () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
    });
    yield* Effect.gen(function* () {
      const reader = yield* DesktopStopIntentReader.DesktopStopIntentReader;
      const fiber = yield* bootstrapScenario(
        "disabled-codex",
        Effect.void,
        undefined,
        Option.none(),
        reader.atShutdown,
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(ready);
      const interrupt = yield* Fiber.interrupt(fiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust(0);
      const didStart = yield* Deferred.isDone(started);
      if (didStart) {
        yield* TestClock.adjust("999 millis");
        assert.isUndefined(interrupt.pollUnsafe());
        yield* TestClock.adjust("1 millis");
      }
      yield* Fiber.join(interrupt);
      assert.isTrue(didStart);
      assert.isTrue(
        messages.some(
          (message) =>
            Array.isArray(message) &&
            message[0] === "Server shutdown intent" &&
            message[1]?.reason === "unknown",
        ),
      );
    }).pipe(Effect.provide(DesktopStopIntentReader.layer("/intent", 123).pipe(Layer.provide(fs))));
  }),
);

it.effect("shutdown finalizer bounds stalled intent I/O and logs unknown", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const fs = FileSystem.layerNoop({
      stream: () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
    });
    yield* Effect.gen(function* () {
      const reader = yield* DesktopStopIntentReader.DesktopStopIntentReader;
      const fiber = yield* bootstrapScenario(
        "disabled-codex",
        Effect.void,
        undefined,
        Option.none(),
        reader.atShutdown,
      ).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.isTrue(
        messages.some(
          (message) =>
            Array.isArray(message) &&
            message[0] === "Server shutdown intent" &&
            message[1]?.reason === "unknown",
        ),
      );
    }).pipe(Effect.provide(DesktopStopIntentReader.layer("/intent", 123).pipe(Layer.provide(fs))));
  }),
);

it.effect("records the duration of provider session shutdown", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const shutdown = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.sleep("3 seconds")),
    );
    const fiber = yield* bootstrapScenario("disabled-codex", shutdown).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 seconds");
    yield* Fiber.join(fiber);
    assert.isTrue(
      messages.some(
        (message) =>
          Array.isArray(message) &&
          message[0] === "Server shutdown phase finished" &&
          message[1]?.phase === "providerSessions" &&
          message[1]?.durationMs === 3000 &&
          message[1]?.outcome === "success",
      ),
    );
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("does not execute a startup mutation whose caller cancelled before readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const mutations = yield* Ref.make(0);
      const cancelled = yield* gate
        .enqueueCommand(Ref.update(mutations, (count) => count + 1))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      const sentinel = yield* gate
        .enqueueCommand(Effect.succeed("drained"))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(sentinel), "drained");
      assert.equal(yield* Ref.get(mutations), 0);
    }),
  ),
);

it.effect(
  "caps startup admission at 64 including the worker's pre-ready entry and reuses cancelled slots",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        const mutations: number[] = [];
        const enqueue = (id: number) =>
          gate
            .enqueueCommand(Effect.sync(() => mutations.push(id)))
            .pipe(Effect.forkScoped({ startImmediately: true }));
        const pending = yield* Effect.forEach(
          Array.from({ length: 64 }, (_, id) => id),
          enqueue,
        );
        const refused = yield* enqueue(64);
        assert.isDefined(refused.pollUnsafe(), "65th startup command must fail immediately");
        const error = yield* Effect.flip(Fiber.join(refused));
        assert.equal(error._tag, "ServerRuntimeStartupError");
        assert.equal(error.cause, "startup-command-capacity");
        assert.deepEqual(mutations, []);

        const [cancelled, ...remaining] = pending;
        if (cancelled === undefined) return yield* Effect.die("missing queued caller");
        yield* Fiber.interrupt(cancelled);
        const replacement = yield* enqueue(65);
        assert.isUndefined(
          replacement.pollUnsafe(),
          "cancellation must release capacity before ready",
        );
        yield* gate.signalCommandReady;
        yield* Effect.forEach([...remaining, replacement], Fiber.join);
        assert.deepEqual(mutations, [...Array.from({ length: 63 }, (_, id) => id + 1), 65]);
      }),
    ),
);

it.effect(
  "keeps the first startup failure terminal across late ready signals for every waiter",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        const mutations = yield* Ref.make(0);
        const failure = new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: null,
          port: 3773,
          cause: "first-failure",
        });
        const commands = yield* Effect.forEach([0, 1, 2], () =>
          gate
            .enqueueCommand(Ref.update(mutations, (n) => n + 1))
            .pipe(Effect.forkScoped({ startImmediately: true })),
        );
        const waiter = yield* gate.awaitCommandReady.pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* gate.failCommandReady(failure);
        yield* gate.signalCommandReady;
        yield* gate.failCommandReady(
          new ServerRuntimeStartup.ServerRuntimeStartupError({
            mode: "web",
            host: null,
            port: 3773,
            cause: "later-failure",
          }),
        );
        yield* gate.signalCommandReady;
        for (const command of commands) {
          assert.strictEqual(yield* Effect.flip(Fiber.join(command)), failure);
        }
        assert.strictEqual(yield* Effect.flip(Fiber.join(waiter)), failure);
        assert.strictEqual(yield* Effect.flip(gate.awaitCommandReady), failure);
        const late = yield* Effect.exit(gate.enqueueCommand(Ref.update(mutations, (n) => n + 1)));
        assert.isTrue(Exit.isFailure(late));
        assert.equal(yield* Ref.get(mutations), 0);
      }),
    ),
);

it.effect(
  "rechecks failed readiness before draining later commands without undoing a started command",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const mutations: string[] = [];
        const active = yield* gate
          .enqueueCommand(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.sync(() => mutations.push("active"))),
              Effect.andThen(Deferred.succeed(completed, undefined)),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const pending = yield* gate
          .enqueueCommand(Effect.sync(() => mutations.push("pending")))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* gate.signalCommandReady;
        yield* Deferred.await(started);
        yield* Fiber.interrupt(active);
        const failure = new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: null,
          port: 3773,
          cause: "failed-after-ready",
        });
        yield* gate.failCommandReady(failure);
        const late = yield* Effect.exit(gate.enqueueCommand(Effect.succeed("must-not-run")));
        assert.isTrue(Exit.isFailure(late));
        const ready = yield* Effect.exit(gate.awaitCommandReady);
        assert.isTrue(Exit.isFailure(ready));
        assert.strictEqual(yield* Effect.flip(Fiber.join(pending)), failure);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(completed);
        assert.deepEqual(mutations, ["active"]);
        yield* gate.signalCommandReady;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(gate.enqueueCommand(Effect.void))));
      }),
    ),
);

it.effect("settles pending startup callers when the gate scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* ServerRuntimeStartup.makeCommandGate.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const pending = yield* gate
        .enqueueCommand(Effect.succeed("must-not-run"))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Scope.close(scope, Exit.void);
      assert.isDefined(pending.pollUnsafe(), "scope close must settle the pending result");
      const error = yield* Effect.flip(Fiber.join(pending));
      assert.equal(error._tag, "ServerRuntimeStartupError");
      yield* gate.signalCommandReady;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(gate.enqueueCommand(Effect.void))));
    }),
  ),
);

it.effect("settles an active startup caller when the gate scope interrupts its command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* ServerRuntimeStartup.makeCommandGate.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const started = yield* Deferred.make<void>();
      const active = yield* gate
        .enqueueCommand(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* gate.signalCommandReady;
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      assert.isDefined(active.pollUnsafe(), "scope close must settle the active result");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(active)));
    }),
  ),
);

it.effect(
  "drains startup commands serially despite command failures and keeps ready calls direct",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const mutations: string[] = [];
        const first = yield* gate
          .enqueueCommand(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.sync(() => mutations.push("first"))),
              Effect.andThen(Effect.fail("command-failed")),
            ),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const cancelled = yield* gate
          .enqueueCommand(Effect.sync(() => mutations.push("cancelled")))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const last = yield* gate
          .enqueueCommand(Effect.sync(() => mutations.push("last")).pipe(Effect.as("last")))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* gate.signalCommandReady;
        yield* Deferred.await(started);
        yield* Fiber.interrupt(cancelled);
        assert.isUndefined(last.pollUnsafe());
        assert.equal(yield* gate.enqueueCommand(Effect.succeed("direct")), "direct");
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Effect.flip(Fiber.join(first)), "command-failed");
        assert.equal(yield* Fiber.join(last), "last");
        assert.deepEqual(mutations, ["first", "last"]);
      }),
    ),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);
