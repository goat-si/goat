import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  makeRunningProcess,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";

const pending = {
  reason: "busy",
  replacement: "incompatible",
  requestedVersion: ARCHIVE.archiveVersion,
  liveVersion: "1.2.2",
} as const;
const ready = {
  status: "ready",
  selectedVersion: ARCHIVE.archiveVersion,
  remotePort: 3773,
  serverKind: "managed",
  refresh: "replaced",
} as const;
const fixture = Effect.gen(function* () {
  const forwarded = yield* Deferred.make<void>();
  const launchEntered = yield* Deferred.make<void>();
  const releaseLaunch = yield* Deferred.make<void>();
  const count = { launches: 0, forwards: 0, pairings: 0, stops: 0, kills: 0, prompts: 0 };
  let mode: "pending" | "ready-pending" | "ready" | "blocked" | "timeout" | "failure" = "pending";
  let stale = false;
  let resolutionFails = false;
  let pairingFails = false;
  let forwardFails = false;
  let versionNewer = false;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
      if (command.args.includes("-G")) {
        if (resolutionFails)
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          };
        return makeSuccessfulProcess("hostname devbox.example.com\nuser julius\nport 2222\n");
      }
      if (command.args.includes("-N")) {
        count.forwards++;
        yield* Deferred.succeed(forwarded, undefined);
        return makeRunningProcess(() => count.kills++);
      }
      const input = command.options.stdin;
      const script =
        input !== undefined &&
        typeof input === "object" &&
        "stream" in input &&
        Stream.isStream(input.stream)
          ? yield* input.stream.pipe(Stream.decodeText(), Stream.mkString)
          : "";
      if (script.includes("ready=false"))
        return makeSuccessfulProcess('{"platform":"linux","arch":"x64","ready":true}');
      if (script.includes("auth pairing create")) {
        count.pairings++;
        return pairingFails
          ? {
              ...makeSuccessfulProcess(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            }
          : makeSuccessfulProcess('{"credential":"pairing"}');
      }
      if (script.includes('"stopped":true')) {
        count.stops++;
        return makeSuccessfulProcess('{"stopped":true}');
      }
      count.launches++;
      if (versionNewer)
        return {
          ...makeSuccessfulProcess(""),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          stderr: Stream.make(
            new TextEncoder().encode(
              "Warning: Permanently added fixture.\nRemote runtime is newer than this app; update the app.",
            ),
          ),
        };
      if (mode === "timeout") {
        yield* Deferred.succeed(launchEntered, undefined);
        return { ...makeSuccessfulProcess(""), exitCode: Effect.never };
      }
      if (mode === "failure")
        return {
          ...makeSuccessfulProcess(""),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        };
      if (mode === "blocked") {
        yield* Deferred.succeed(launchEntered, undefined);
        yield* Deferred.await(releaseLaunch);
      }
      return makeSuccessfulProcess(
        JSON.stringify(
          mode === "pending"
            ? { status: "pending", pending }
            : mode === "ready-pending"
              ? { ...ready, selectedVersion: "1.2.2", refresh: undefined, pending }
              : ready,
        ),
      );
    }),
  );
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        stale
          ? Effect.never
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      ),
    ),
    Layer.succeed(NetService.NetService, {
      ...testNetService,
      reserveLoopbackPort: () =>
        forwardFails
          ? Effect.fail(new NetService.NetError({ message: "fixture port failure" }))
          : testNetService.reserveLoopbackPort(),
    }),
    Layer.succeed(SshAuth.SshPasswordPrompt, {
      isAvailable: true,
      request: () =>
        Effect.sync(() => {
          count.prompts++;
          return "password";
        }),
    }),
    SshTunnel.SshEnvironmentManager.layer({
      resolveCliRunner: Effect.succeed({ ...ARCHIVE, refreshOwnedRuntimeOnFirstConnection: true }),
    }),
  );
  return {
    layer,
    count,
    forwarded,
    launchEntered,
    releaseLaunch,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    setStale: (value: boolean) => {
      stale = value;
    },
    failResolution: () => {
      resolutionFails = true;
    },
    failForward: (value: boolean) => {
      forwardFails = value;
    },
    refuseNewer: () => {
      versionNewer = true;
    },
    failPairing: (value: boolean) => {
      pairingFails = value;
    },
  };
});

describe("SSH pending replacement reconciliation", () => {
  it.effect.each(["replacement", "stale", "disconnect"] as const)(
    "interrupted %s close cannot leak a removed forward",
    (action) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode(action === "replacement" ? "ready-pending" : "ready");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          f.setMode("ready");
          if (action === "stale") f.setStale(true);
          let interrupt: (() => void) | undefined;
          let interrupted = false;
          const tracer = Tracer.make({
            span(options) {
              if (!interrupted && options.name === "ssh/tunnel.closeTunnelEntry") {
                interrupted = true;
                interrupt?.();
              }
              return new Tracer.NativeSpan(options);
            },
          });
          const closing = yield* Effect.withFiber((fiber) => {
            interrupt = () => fiber.interruptUnsafe();
            return action === "disconnect"
              ? manager.disconnectEnvironment(uploadTarget)
              : manager.ensureEnvironment(uploadTarget);
          }).pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.forkChild);
          if (action === "stale") yield* TestClock.adjust("2 seconds");
          assert.isTrue(Exit.isFailure(yield* Fiber.await(closing)));
          assert.isTrue(interrupted);
          assert.equal(f.count.kills, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
        assert.equal(f.count.kills, 1);
      }),
  );

  it.effect(
    "failed first connect creates no background retry or speculative disconnect exemption",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("failure");
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          assert.isTrue(
            Result.isFailure(yield* Effect.result(manager.ensureEnvironment(uploadTarget))),
          );
          f.setMode("ready");
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.count.launches, 1);
          assert.equal(f.count.forwards, 0);
          yield* manager.disconnectEnvironment(uploadTarget);
          assert.equal(f.count.stops, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect("failed stale reconnect does not exempt the managed remote from disconnect stop", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.setStale(true);
        f.setMode("failure");
        const reconnect = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* TestClock.adjust("2 seconds");
        assert.isTrue(Result.isFailure(yield* Fiber.join(reconnect)));
        yield* manager.disconnectEnvironment(uploadTarget);
        assert.equal(f.count.stops, 1);
        assert.equal(f.count.kills, 1);
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("disconnect clears real intent after the alias no longer resolves", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.failResolution();
        yield* manager.disconnectEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.stops, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("mid-interval intent retries within one minute of its own deadline", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("failure");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* Effect.result(manager.ensureEnvironment(uploadTarget));
        yield* TestClock.adjust(270_000);
        f.setMode("pending");
        yield* manager.ensureEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        assert.equal(f.count.launches, 2);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(f.forwarded);
        assert.equal(f.count.launches, 3);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect.each(["ready", "pending"] as const)(
    "disconnect during a retry honors the real %s launch result",
    (result) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          f.setMode("blocked");
          const launch = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)),
          );
          yield* Deferred.await(f.launchEntered);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(uploadTarget));
          yield* TestClock.adjust(0);
          f.setMode(result);
          yield* Deferred.succeed(f.releaseLaunch, undefined);
          assert.isTrue(Result.isFailure(yield* Fiber.join(launch)));
          yield* Fiber.join(disconnect);
          assert.equal(f.count.stops, result === "ready" ? 1 : 0);
          yield* TestClock.adjust("20 minutes");
          assert.equal(f.count.launches, 2);
          assert.equal(f.count.forwards, 0);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect("pending without a port creates no forward or credentials; reconnect settles it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        assert.equal("type" in first ? first.type : "ready", "ssh-runtime-pending");
        assert.equal(f.count.forwards, 0);
        assert.equal(f.count.pairings, 0);
        f.setMode("ready");
        const second = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        assert.isFalse("type" in second);
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.forwards, 1);
        assert.equal(f.count.pairings, 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("one scoped ten-minute retry uses noninteractive auth and caches its forward", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.forwarded);
        const second = yield* manager.ensureEnvironment(uploadTarget);
        assert.isFalse("type" in second);
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.prompts, 0);
        assert.equal(f.count.pairings, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect(
    "healthy cached entries reconcile intent after pairing failure and retain their local port",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setMode("ready-pending");
        f.failPairing(true);
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const failed = yield* Effect.result(
            manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
          );
          assert.isTrue(Result.isFailure(failed));
          f.failPairing(false);
          f.setMode("ready");
          const replaced = yield* manager.ensureEnvironment(uploadTarget, {
            issuePairingToken: true,
          });
          if ("type" in replaced) throw new Error("Expected ready");
          assert.equal(replaced.httpBaseUrl, "http://127.0.0.1:41773/");
          assert.equal(f.count.forwards, 2);
          assert.equal(f.count.stops, 0);
          assert.equal(f.count.kills, 1);
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.count.launches, 2);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );

  it.effect("disconnect cancels intent and does not stop the busy remote", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        yield* manager.disconnectEnvironment(uploadTarget);
        f.setMode("ready");
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.stops, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
      assert.equal(f.count.stops, 0);
    }),
  );

  it.effect("cancelled in-flight launch cannot resurrect pending intent or forwarding", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("blocked");
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const launch = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(uploadTarget)),
        );
        yield* Deferred.await(f.launchEntered);
        const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(uploadTarget));
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(f.releaseLaunch, undefined);
        assert.isTrue(Result.isFailure(yield* Fiber.join(launch)));
        yield* Fiber.join(disconnect);
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.forwards, 0);
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.stops, 1);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );
  it.effect(
    "transport timeout retains only real intent and the queued retry settles without password prompts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          f.setMode("timeout");
          const launch = yield* Effect.forkChild(
            Effect.result(manager.ensureEnvironment(uploadTarget)),
          );
          yield* Deferred.await(f.launchEntered);
          f.setMode("ready");
          yield* TestClock.adjust("15 minutes");
          assert.isTrue(Result.isFailure(yield* Fiber.join(launch)));
          yield* Deferred.await(f.forwarded);
          yield* manager.ensureEnvironment(uploadTarget);
          assert.equal(f.count.launches, 3);
          assert.equal(f.count.prompts, 0);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }),
  );
  it.effect("forward admission failure retains intent for the ten-minute retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setMode("ready-pending");
      f.failForward(true);
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.ensureEnvironment(uploadTarget))),
        );
        f.failForward(false);
        f.setMode("ready");
        yield* TestClock.adjust("10 minutes");
        yield* Deferred.await(f.forwarded);
        yield* manager.ensureEnvironment(uploadTarget);
        assert.equal(f.count.launches, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );

  it.effect("newer-incompatible refusal creates no replacement retry intent", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(uploadTarget);
        f.refuseNewer();
        assert.isTrue(
          Result.isFailure(yield* Effect.result(manager.ensureEnvironment(uploadTarget))),
        );
        yield* TestClock.adjust("20 minutes");
        assert.equal(f.count.launches, 2);
        assert.equal(f.count.forwards, 0);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }),
  );
});
