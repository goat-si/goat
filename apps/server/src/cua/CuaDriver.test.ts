import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type CuaDriverMcpConfiguration,
  type DesktopCuaDriverReport,
} from "@goat/contracts";
import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as CuaDisplay from "./CuaDisplayCapability.ts";
import * as CuaDriver from "./CuaDriver.ts";

const mcp: CuaDriverMcpConfiguration = {
  command: "/driver",
  args: ["mcp"],
  environment: [
    { name: "PATH", value: "/bin" },
    { name: "CUA_TELEMETRY", value: "1" },
  ],
};

// Agents spawn the MCP proxy from this descriptor, so it always carries every driver opt-out.
const served = (config: CuaDriverMcpConfiguration) =>
  Option.some({
    ...config,
    environment: [
      { name: "PATH", value: "/bin" },
      { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
      { name: "CUA_TELEMETRY_ENABLED", value: "false" },
      { name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" },
      { name: "DO_NOT_TRACK", value: "1" },
      { name: "CUA_TELEMETRY", value: "0" },
    ],
  });

const makeHost = Effect.fnUntraced(function* () {
  const started = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const watching = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<CuaDriverMcpConfiguration, CuaDriver.CuaDriverError>();
  const exited = yield* Deferred.make<void, CuaDriver.CuaDriverError>();
  let stops = 0;
  const host: CuaDriver.CuaDriverHost = {
    start: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(ready))),
    stop: Effect.sync(() => {
      stops++;
    }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined)), Effect.asVoid),
    waitForExit: Deferred.succeed(watching, undefined).pipe(Effect.andThen(Deferred.await(exited))),
  };
  return { host, started, stopped, watching, ready, exited, stops: () => stops };
});

const testDisplay: CuaDisplay.CuaDisplayProbe = {
  capability: "available",
  reason: "Uses X display :9.",
  display: ":9",
  environment: [{ name: "DISPLAY", value: ":9" }],
};
const { environment: _, ...reportedDisplay } = testDisplay;

const makeService = Effect.fnUntraced(function* (
  createHost:
    | Effect.Effect<CuaDriver.CuaDriverHost, CuaDriver.CuaDriverError>
    | CuaDriver.CuaDriverHostFactory,
  initialEnabled = true,
  probe: Effect.Effect<CuaDisplay.CuaDisplayProbe> = Effect.succeed(testDisplay),
  options: CuaDriver.CuaDriverOptions = {},
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const values = yield* settings.getSettings;
  const enabled = yield* Ref.make(initialEnabled);
  const changes = yield* PubSub.unbounded<boolean>();
  const factory = typeof createHost === "function" ? createHost : () => createHost;
  const service = yield* CuaDriver.make(factory, probe, options).pipe(
    Effect.provideService(ServerSettings.ServerSettingsService, {
      ...settings,
      getSettings: Ref.get(enabled).pipe(Effect.map((enableCua) => ({ ...values, enableCua }))),
      subscribeChanges: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.map((enableCua) => ({ ...values, enableCua })),
          ),
        ),
      ),
    }),
  );
  return {
    service,
    setEnabled: (value: boolean) =>
      Ref.set(enabled, value).pipe(Effect.andThen(PubSub.publish(changes, value))),
  };
});

it.layer(ServerSettings.layerTest())("CuaDriver lifecycle", (it) => {
  it.effect("defaults to disabled and never acquires a host before opt-in", () =>
    Effect.gen(function* () {
      expect(DEFAULT_SERVER_SETTINGS.enableCua).toBe(false);
      const { service } = yield* makeService(Effect.die("unexpected host acquisition"), false);
      expect(yield* service.enabled).toBe(false);
      expect(yield* service.acquire).toEqual(Option.none());
    }).pipe(Effect.scoped),
  );

  it.effect("shares slow preparation, survives one caller cancellation, and owns cleanup", () =>
    Effect.gen(function* () {
      const h = yield* makeHost();
      const preparing = yield* Deferred.make<void>();
      const prepared = yield* Deferred.make<void>();
      let creates = 0;
      yield* Effect.gen(function* () {
        const { service } = yield* makeService(
          Effect.gen(function* () {
            creates++;
            yield* Deferred.succeed(preparing, undefined);
            yield* Deferred.await(prepared);
            return h.host;
          }),
        );
        expect(creates).toBe(0);
        const first = yield* service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(preparing);
        const second = yield* service.acquire.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* TestClock.adjust("31 seconds");
        yield* Deferred.succeed(prepared, undefined);
        yield* Deferred.succeed(h.ready, mcp);
        expect(yield* Fiber.join(second)).toEqual(served(mcp));
        expect(yield* service.acquire).toEqual(served(mcp));
        expect(creates).toBe(1);
        expect(h.stops()).toBe(0);
      }).pipe(Effect.scoped);
      expect(h.stops()).toBe(1);
    }),
  );

  it.effect("retries failed starts, clears the failure, and replaces a crashed connection", () =>
    Effect.gen(function* () {
      const failed = yield* makeHost();
      const crashed = yield* makeHost();
      const replacement = yield* makeHost();
      const hosts = [failed, crashed, replacement];
      let creates = 0;
      const { service } = yield* makeService(Effect.sync(() => hosts[creates++]!.host));
      yield* Deferred.fail(
        failed.ready,
        new CuaDriver.CuaDriverStartError({
          binaryPath: "/driver",
          cause: new Error("native start failed"),
        }),
      );
      expect(yield* service.acquire).toEqual(Option.none());
      expect(failed.stops()).toBe(1);
      expect(Option.isSome(yield* service.lastFailure)).toBe(true);
      yield* Deferred.succeed(crashed.ready, mcp);
      expect(yield* service.acquire).toEqual(served(mcp));
      expect(yield* service.lastFailure).toEqual(Option.none());
      yield* Deferred.await(crashed.watching);
      const waitError = new CuaDriver.CuaDriverHostError({
        operation: "exit",
        cause: new Error("native waitForExit failed"),
      });
      yield* Deferred.fail(crashed.exited, waitError);
      yield* Deferred.await(crashed.stopped);
      expect(Option.getOrThrow(yield* service.lastFailure)).toBe(waitError);
      const next = { ...mcp, args: ["mcp", "--generation=next"] };
      yield* Deferred.succeed(replacement.ready, next);
      expect(yield* service.acquire).toEqual(served(next));
      expect(creates).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("disabling stops the active host and re-enabling starts a fresh one", () =>
    Effect.gen(function* () {
      const first = yield* makeHost();
      const second = yield* makeHost();
      let creates = 0;
      const h = yield* makeService(Effect.sync(() => (creates++ === 0 ? first.host : second.host)));
      yield* Deferred.succeed(first.ready, mcp);
      expect(yield* h.service.acquire).toEqual(served(mcp));
      yield* h.setEnabled(false);
      yield* Deferred.await(first.stopped);
      expect(yield* h.service.acquire).toEqual(Option.none());
      expect(creates).toBe(1);
      yield* h.setEnabled(true);
      yield* Deferred.succeed(second.ready, mcp);
      expect(yield* h.service.acquire).toEqual(served(mcp));
      expect(creates).toBe(2);
      expect(first.stops()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a revoked start cannot publish its late descriptor or stop its replacement", () =>
    Effect.gen(function* () {
      const first = yield* makeHost();
      const second = yield* makeHost();
      const lateFinished = yield* Deferred.make<void>();
      let creates = 0;
      const h = yield* makeService(
        Effect.sync(() =>
          creates++ === 0
            ? {
                ...first.host,
                start: first.host.start.pipe(
                  Effect.uninterruptible,
                  Effect.ensuring(Deferred.succeed(lateFinished, undefined)),
                ),
              }
            : second.host,
        ),
      );
      const pending = yield* h.service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(first.started);
      yield* h.setEnabled(false);
      yield* Deferred.await(first.stopped);
      expect(yield* Fiber.join(pending)).toEqual(Option.none());
      yield* h.setEnabled(true);
      const next = { ...mcp, command: "/replacement" };
      yield* Deferred.succeed(second.ready, next);
      expect(yield* h.service.acquire).toEqual(served(next));
      yield* Deferred.succeed(first.ready, mcp);
      yield* Deferred.await(lateFinished);
      expect(yield* h.service.acquire).toEqual(served(next));
      expect(first.stops()).toBe(1);
      expect(second.stops()).toBe(0);
    }).pipe(Effect.scoped),
  );
});

const nativeFixture = Effect.fnUntraced(function* (platform?: NodeJS.Platform) {
  const start = Promise.withResolvers<EmbeddedDriverConnection>();
  const stop = Promise.withResolvers<void>();
  const started = yield* Deferred.make<void>();
  const stopping = yield* Deferred.make<void>();
  const destroyed = yield* Deferred.make<void>();
  const connection: EmbeddedDriverConnection = {
    socketPath: "/socket",
    pid: 1,
    generation: "first",
    driverVersion: "test",
    contractVersion: "test",
    mcpProtocolVersion: "test",
    mcp: { command: mcp.command, args: [...mcp.args], environment: [...mcp.environment] },
  };
  let destroys = 0;
  let creates = 0;
  const options: Array<{
    readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }> = [];
  const factory = yield* CuaDriver.makeStandaloneHostFactory(
    Effect.succeed("/driver"),
    () => Effect.succeed("/state/cua-driver/capability-manifest.yaml"),
    Effect.succeed({
      EmbeddedCuaDriverHost: class {
        static withOptions(given: (typeof options)[number]) {
          options.push(given);
          return new this();
        }
        constructor() {
          creates++;
        }
        start() {
          Deferred.doneUnsafe(started, Effect.void);
          return start.promise;
        }
        stop() {
          Deferred.doneUnsafe(stopping, Effect.void);
          return stop.promise;
        }
        waitForExit(_generation: string, options?: { signal: AbortSignal }) {
          return new Promise<never>((_resolve, reject) => {
            if (options?.signal.aborted) reject(new Error("aborted"));
            else
              options?.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
          });
        }
        uniffiDestroy() {
          destroys++;
          Deferred.doneUnsafe(destroyed, Effect.void);
        }
      },
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    platform === undefined
      ? (effect) => effect
      : Effect.provideService(HostProcess.Platform, platform),
  );
  return {
    factory,
    connection,
    start,
    stop,
    started,
    stopping,
    destroyed,
    options: () => options,
    creates: () => creates,
    destroys: () => destroys,
  };
});

// What the pinned 0.37.0 SDK hands the daemon (embedded.rs merge_safe_environment): GOAT's own
// allowlisted variables, then the options' environment over them. Every name here is allowlisted.
const daemonEnvironment = (
  parent: Readonly<Record<string, string>>,
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => {
  const values = new Map(
    Object.entries(parent).map(([name, value]) => [name.toUpperCase(), value]),
  );
  for (const variable of environment) values.set(variable.name.toUpperCase(), variable.value);
  return Object.fromEntries(values);
};

it.layer(ServerSettings.layerTest())("CuaDriver native ownership", (it) => {
  it.effect("keeps a session bus the display probe rejected away from a Linux daemon", () =>
    Effect.gen(function* () {
      const parent = { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" };
      const daemonFor = Effect.fnUntraced(function* (
        platform: NodeJS.Platform,
        display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>,
      ) {
        const f = yield* nativeFixture(platform);
        const host = yield* f.factory(display);
        f.stop.resolve();
        yield* host.stop;
        return daemonEnvironment(parent, f.options()[0]!.environment);
      });

      // The probe found the inherited bus dead and supplied none.
      const rejected = yield* daemonFor("linux", [{ name: "DISPLAY", value: ":0" }]);
      expect(rejected.DBUS_SESSION_BUS_ADDRESS).toBe("");
      expect(rejected.DISPLAY).toBe(":0");
      expect(rejected.PATH).toBe("/usr/bin");

      const probed = yield* daemonFor("linux", [
        { name: "DISPLAY", value: ":0" },
        { name: "DBUS_SESSION_BUS_ADDRESS", value: "unix:path=/run/user/1000/bus" },
      ]);
      expect(probed.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");

      // A Mac's daemon has no probed session bus to protect.
      const mac = yield* daemonFor("darwin", []);
      expect(mac.DBUS_SESSION_BUS_ADDRESS).toBe(parent.DBUS_SESSION_BUS_ADDRESS);
    }).pipe(Effect.scoped),
  );

  it.effect("times out native startup after 30 seconds and cleans up when it settles", () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const { service } = yield* makeService(f.factory);
      const acquiring = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(f.started);
      yield* TestClock.adjust("29 seconds");
      expect(yield* service.lastFailure).toEqual(Option.none());
      yield* TestClock.adjust("1 second");
      expect(yield* service.lastFailure).toEqual(
        Option.some(new CuaDriver.CuaDriverHostError({ operation: "timeout" })),
      );
      expect(f.destroys()).toBe(0);
      f.start.resolve(f.connection);
      yield* Deferred.await(f.stopping);
      f.stop.resolve();
      yield* Deferred.await(f.destroyed);
      expect(yield* Fiber.join(acquiring)).toEqual(Option.none());
      expect(f.destroys()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("names a manifest the driver refused at startup in host status", () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const { service } = yield* makeService(f.factory);
      const acquiring = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(f.started);
      // What the 0.37.0 SDK reports when the daemon rejects its manifest and exits with 64.
      f.start.reject(new Error("embedded cua-driver exited before readiness (code=Some(64))"));
      yield* Deferred.await(f.stopping);
      f.stop.resolve();
      expect(yield* Fiber.join(acquiring)).toEqual(Option.none());
      expect((yield* service.status).failure).toBe(CuaDriver.CUA_DRIVER_REFUSED_MESSAGE);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["start", "stop"] as const)(
    "bounds shutdown with native %s pending without destroying or reusing its owner",
    (pending) =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        const scope = yield* Scope.make();
        const { service } = yield* makeService(f.factory).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const acquiring = yield* service.acquire.pipe(Effect.forkChild);
        yield* Deferred.await(f.started);
        if (pending === "stop") {
          f.start.resolve(f.connection);
          expect(yield* Fiber.join(acquiring)).toEqual(served({ ...mcp, socketPath: "/socket" }));
        }
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        if (pending === "stop") yield* Deferred.await(f.stopping);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(closing);
        expect(f.destroys()).toBe(0);
        expect(Exit.isFailure(yield* Effect.exit(f.factory([])))).toBe(true);
        expect(f.creates()).toBe(1);
        f.start.resolve(f.connection);
        yield* Deferred.await(f.stopping);
        expect(f.destroys()).toBe(0);
        f.stop.resolve();
        yield* Deferred.await(f.destroyed);
        const replacement = yield* f.factory([]);
        expect(f.creates()).toBe(2);
        yield* replacement.stop;
        expect(f.destroys()).toBe(2);
        expect(yield* service.acquire).toEqual(Option.none());
      }).pipe(Effect.scoped),
  );
});

const healthy: DesktopTelemetryReceiver.DesktopTelemetryReceiverHealth = {
  status: "healthy",
  lastSampleAt: Option.none(),
  lastError: Option.none(),
};

const desktopFixture = Effect.fnUntraced(function* (
  synchronous = false,
  healthChanges: Stream.Stream<DesktopTelemetryReceiver.DesktopTelemetryReceiverHealth> = Stream.empty,
  beforeHealth = Effect.void,
) {
  const reports = yield* PubSub.unbounded<DesktopCuaDriverReport>();
  const requested = yield* Deferred.make<string>();
  const disabled = yield* Deferred.make<void>();
  const watching = yield* Deferred.make<void>();
  const requests: boolean[] = [];
  const factory = yield* CuaDriver.makeDesktopHostFactory().pipe(
    Effect.provide(
      DesktopTelemetryReceiver.layerTest({
        health: Effect.succeed(healthy),
        subscribeHealth: beforeHealth.pipe(Effect.as({ latest: healthy, changes: healthChanges })),
        cuaReports: Stream.fromPubSub(reports),
        requestCuaDriver: (requestId, enabled) =>
          Effect.gen(function* () {
            requests.push(enabled);
            if (enabled) {
              yield* Deferred.succeed(requested, requestId);
              if (synchronous)
                yield* PubSub.publish(reports, {
                  version: 1,
                  type: "cuaDriverReport",
                  requestId,
                  status: "ready",
                  mcp,
                });
            } else {
              yield* PubSub.publish(reports, {
                version: 1,
                type: "cuaDriverReport",
                requestId,
                status: "stopped",
              });
              yield* Deferred.succeed(disabled, undefined);
            }
          }),
      }),
    ),
  );
  return {
    factory: (display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>) =>
      factory(display).pipe(
        Effect.map((host) => ({
          ...host,
          waitForExit: Deferred.succeed(watching, undefined).pipe(Effect.andThen(host.waitForExit)),
        })),
      ),
    reports,
    requested,
    disabled,
    watching,
    requests,
  };
});

it.effect.each([false, true])(
  "uses the supplied desktop receiver for correlated replies (synchronous: %s) and acknowledged stop",
  (synchronous) =>
    Effect.gen(function* () {
      const { factory, reports, requested, requests } = yield* desktopFixture(synchronous);
      yield* Effect.gen(function* () {
        const { service } = yield* makeService(factory);
        const acquiring = yield* service.acquire.pipe(Effect.forkChild);
        const requestId = yield* Deferred.await(requested);
        yield* PubSub.publish(reports, {
          version: 1,
          type: "cuaDriverReport",
          requestId: "unrelated",
          status: "ready",
          mcp: { ...mcp, command: "/wrong" },
        });
        yield* PubSub.publish(reports, {
          version: 1,
          type: "cuaDriverReport",
          requestId,
          status: "ready",
          mcp,
        });
        expect(yield* Fiber.join(acquiring)).toEqual(served(mcp));
        expect(yield* service.acquire).toEqual(served(mcp));
      }).pipe(Effect.scoped);
      expect(requests).toEqual([true, false]);
    }).pipe(Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]), Effect.scoped),
);

it.effect("does not enable a desktop host retired while subscribing to health", () =>
  Effect.gen(function* () {
    const subscribing = yield* Deferred.make<void>();
    const releaseHealth = yield* Deferred.make<void>();
    const startFinished =
      yield* Deferred.make<Exit.Exit<CuaDriverMcpConfiguration, CuaDriver.CuaDriverError>>();
    const f = yield* desktopFixture(
      false,
      Stream.empty,
      Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Deferred.await(releaseHealth))),
    );
    const scope = yield* Scope.make();
    const { service } = yield* makeService((display) =>
      f.factory(display).pipe(
        Effect.map((host) => ({
          ...host,
          start: host.start.pipe(Effect.onExit((exit) => Deferred.succeed(startFinished, exit))),
        })),
      ),
    ).pipe(Effect.provideService(Scope.Scope, scope));
    const acquiring = yield* service.acquire.pipe(Effect.forkChild);
    yield* Deferred.await(subscribing);
    yield* Scope.close(scope, Exit.void);
    expect(yield* Fiber.join(acquiring)).toEqual(Option.none());
    yield* Deferred.succeed(releaseHealth, undefined);
    const result = yield* Deferred.await(startFinished);
    expect(result).toEqual(Exit.fail(new CuaDriver.CuaDriverHostError({ operation: "desktop" })));
    expect(f.requests).toEqual([]);
  }).pipe(Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]), Effect.scoped),
);

it.effect("preserves the desktop driver through degraded telemetry until the receiver stops", () =>
  Effect.gen(function* () {
    const streamQueue =
      yield* Queue.unbounded<
        Stream.Stream<DesktopTelemetryReceiver.DesktopTelemetryReceiverHealth>
      >();
    const processed = yield* Deferred.make<void>();
    const f = yield* desktopFixture(true, Stream.fromQueue(streamQueue).pipe(Stream.flatten));
    const { service } = yield* makeService(f.factory);
    const descriptor = yield* service.acquire;
    expect(descriptor).toEqual(served(mcp));
    // Acquisition resolves before the exit watcher starts; wait so a false exit cannot go unnoticed.
    yield* Deferred.await(f.watching);
    yield* Queue.offer(
      streamQueue,
      Stream.make({ ...healthy, status: "degraded" as const }).pipe(
        // The next stream runs only after the health listener consumes the degraded event.
        Stream.concat(Stream.fromEffect(Deferred.succeed(processed, undefined)).pipe(Stream.drain)),
      ),
    );
    yield* Effect.raceFirst(Deferred.await(processed), Deferred.await(f.disabled));
    expect(f.requests).toEqual([true]);
    expect(yield* service.acquire).toEqual(descriptor);
    expect(f.requests).toEqual([true]);
    expect(yield* service.lastFailure).toEqual(Option.none());
    yield* Queue.offer(streamQueue, Stream.make({ ...healthy, status: "stopped" as const }));
    yield* Deferred.await(f.disabled);
    expect(f.requests).toEqual([true, false]);
    expect(yield* service.lastFailure).toEqual(
      Option.some(new CuaDriver.CuaDriverHostError({ operation: "exit" })),
    );
  }).pipe(Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]), Effect.scoped),
);

it.effect.each(["linux", "darwin"] as const)(
  "starts an explicit driver path in standard mode under GOAT's manifest, privately on %s",
  (platform) =>
    Effect.gen(function* () {
      let options:
        | {
            readonly binaryPath: string;
            readonly environment: unknown;
            readonly permissionMode?: number;
            readonly capabilityManifestPath?: string;
            readonly approveCapabilityManifest: boolean;
            readonly dangerouslyBypassApprovals: boolean;
          }
        | undefined;
      const prepared: Array<string> = [];
      const factory = yield* CuaDriver.makeStandaloneHostFactory(
        Effect.die("installer must not run"),
        (binaryPath) =>
          Effect.sync(() => {
            prepared.push(binaryPath);
            return "/state/cua-driver/capability-manifest.yaml";
          }),
        Effect.succeed({
          EmbeddedCuaDriverHost: {
            withOptions: (received) => {
              options = received;
              return {
                start: () => Promise.reject(new Error("unused")),
                stop: () => Promise.resolve(),
                waitForExit: () => Promise.reject(new Error("unused")),
                uniffiDestroy: () => {},
              };
            },
          },
        }),
      ).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(HostProcess.Environment, {
          GOAT_CUA_DRIVER_PATH: "/explicit/driver",
        }),
      );
      // A display variable cannot turn telemetry back on: the privacy switches always win.
      const host = yield* factory([
        { name: "DISPLAY", value: ":1" },
        { name: "XAUTHORITY", value: "/root/.Xauthority" },
        { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "true" },
      ]);
      expect(options?.binaryPath).toBe("/explicit/driver");
      // The manifest is written for the binary that loads it, before the daemon starts.
      expect(prepared).toEqual(["/explicit/driver"]);
      expect(options).toMatchObject({
        permissionMode: 0,
        capabilityManifestPath: "/state/cua-driver/capability-manifest.yaml",
        approveCapabilityManifest: true,
        dangerouslyBypassApprovals: false,
      });
      // The driver reads these after DO_NOT_TRACK, which its embedded allowlist cannot forward.
      // On Linux a session bus the probe did not supply is passed empty so none is inherited.
      expect(options?.environment).toEqual([
        { name: "DISPLAY", value: ":1" },
        { name: "XAUTHORITY", value: "/root/.Xauthority" },
        ...(platform === "linux" ? [{ name: "DBUS_SESSION_BUS_ADDRESS", value: "" }] : []),
        { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
        { name: "CUA_TELEMETRY_ENABLED", value: "false" },
        { name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" },
      ]);
      yield* host.stop;
    }),
);

it.effect(
  "reports the host platform, Wayland, and running only between readiness and disable",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHost();
      const { service, setEnabled } = yield* makeService(Effect.succeed(h.host));
      expect(yield* service.status).toEqual({
        platform: "linux",
        running: false,
        tools: "unavailable",
        wayland: true,
        display: reportedDisplay,
      });
      const acquiring = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.await(h.started);
      expect((yield* service.status).running).toBe(false);
      yield* Deferred.succeed(h.ready, mcp);
      expect(yield* Fiber.join(acquiring)).toEqual(served(mcp));
      expect((yield* service.status).running).toBe(true);
      yield* setEnabled(false);
      yield* Deferred.await(h.stopped);
      expect(yield* service.status).toEqual({
        platform: "linux",
        running: false,
        tools: "off",
        wayland: true,
        display: reportedDisplay,
      });
    }).pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { XDG_SESSION_TYPE: "wayland" }),
      Effect.scoped,
    ),
);

it.effect("shows the desktop's reason when it cannot start the driver", () =>
  Effect.gen(function* () {
    const f = yield* desktopFixture();
    const { service } = yield* makeService(f.factory);
    const acquiring = yield* service.acquire.pipe(Effect.forkChild);
    const message =
      "Allow Accessibility and Screen Recording in System Settings, then restart computer use.";
    const block = { reason: "permissionsNotGranted", missing: ["screenRecording"] } as const;
    yield* PubSub.publish(f.reports, {
      version: 1,
      type: "cuaDriverReport",
      requestId: yield* Deferred.await(f.requested),
      status: "unavailable",
      message,
      block: { ...block, holder: "helper" },
    });
    expect(yield* Fiber.join(acquiring)).toEqual(Option.none());
    expect(yield* service.status).toEqual({
      platform: "darwin",
      running: false,
      tools: "unavailable",
      failure: message,
      block: { ...block, holder: "helper" },
      display: reportedDisplay,
    });
  }).pipe(
    Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.scoped,
  ),
);

it.effect("treats a desktop restart as a stop, then starts fresh for the next session", () =>
  Effect.gen(function* () {
    const f = yield* desktopFixture(true);
    const { service } = yield* makeService(f.factory);
    expect(yield* service.acquire).toEqual(served(mcp));
    yield* Deferred.await(f.watching);
    // The desktop retires a driver that predates new macOS grants without being asked.
    yield* PubSub.publish(f.reports, {
      version: 1,
      type: "cuaDriverReport",
      requestId: yield* Deferred.await(f.requested),
      status: "stopped",
    });
    yield* Deferred.await(f.disabled);
    expect(yield* service.status).toEqual({
      platform: "darwin",
      running: false,
      tools: "unavailable",
      display: reportedDisplay,
    });
    expect(yield* service.lastFailure).toEqual(Option.none());
    expect(yield* service.acquire).toEqual(served(mcp));
    expect(f.requests).toEqual([true, false, true]);
  }).pipe(
    Effect.provide([ServerSettings.layerTest(), NodeCrypto.layer]),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.scoped,
  ),
);

it.layer(ServerSettings.layerTest())("CuaDriver display gate", (it) => {
  const reason =
    "No X display is reachable for root. Sign in to a desktop session on this computer or start Xvfb.";
  const unavailable = Effect.succeed<CuaDisplay.CuaDisplayProbe>({
    capability: "unavailable",
    reason,
    environment: [],
  });

  it.effect("refuses to start without a usable screen and reports why", () =>
    Effect.gen(function* () {
      const { service } = yield* makeService(
        Effect.die("a host must not start without a screen"),
        true,
        unavailable,
      );
      expect(yield* service.acquire).toEqual(Option.none());
      expect(yield* service.lastFailure).toEqual(
        Option.some(new CuaDriver.CuaDriverHostError({ operation: "display", cause: reason })),
      );
      const status = yield* service.status;
      expect(status.failure).toBe(reason);
      expect(status.display).toEqual({ capability: "unavailable", reason });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to turn on where the screen is unusable, but lets an enabled host save", () =>
    Effect.gen(function* () {
      const off = yield* makeService(Effect.die("unused"), false, unavailable);
      const refused = yield* Effect.flip(off.service.admitEnable);
      expect(refused.message).toBe(reason);
      const on = yield* makeService(Effect.die("unused"), true, unavailable);
      yield* on.service.admitEnable;
      const partial = yield* makeService(
        Effect.die("unused"),
        false,
        Effect.succeed({ ...testDisplay, capability: "partial" as const }),
      );
      yield* partial.service.admitEnable;
    }).pipe(Effect.scoped),
  );

  it.effect("probes again at every start and runs each host on that display", () =>
    Effect.gen(function* () {
      const hosts = [yield* makeHost(), yield* makeHost()];
      const seen: Array<ReadonlyArray<CuaDisplay.CuaDisplayVariable>> = [];
      let probes = 0;
      const probe = Effect.sync(() => {
        probes++;
        return { ...testDisplay, environment: [{ name: "DISPLAY", value: `:${probes}` }] };
      });
      const { service } = yield* makeService(
        (display) =>
          Effect.sync(() => {
            seen.push(display);
            return hosts[seen.length - 1]!.host;
          }),
        true,
        probe,
      );
      const first = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.succeed(hosts[0]!.ready, mcp);
      expect(yield* Fiber.join(first)).toEqual(served(mcp));
      yield* Deferred.await(hosts[0]!.watching);
      yield* Deferred.succeed(hosts[0]!.exited, undefined);
      yield* Deferred.await(hosts[0]!.stopped);
      const second = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.succeed(hosts[1]!.ready, mcp);
      expect(yield* Fiber.join(second)).toEqual(served(mcp));
      expect(seen).toEqual([
        [{ name: "DISPLAY", value: ":1" }],
        [{ name: "DISPLAY", value: ":2" }],
      ]);
    }).pipe(Effect.scoped),
  );
});

it.layer(ServerSettings.layerTest())("CuaDriver enable and grants", (it) => {
  it.effect(
    "turns on only after the verified install completes, and reports install failures",
    () =>
      Effect.gen(function* () {
        let installs = 0;
        const install = Effect.sync(() => {
          installs++;
        });
        const off = yield* makeService(Effect.die("unused"), false, undefined, { install });
        yield* off.service.admitEnable;
        expect(installs).toBe(1);

        const blocked = yield* makeService(
          Effect.die("unused"),
          false,
          Effect.succeed({ capability: "unavailable", reason: "No X display.", environment: [] }),
          { install },
        );
        yield* Effect.flip(blocked.service.admitEnable);
        expect(installs).toBe(1);

        const on = yield* makeService(Effect.die("unused"), true, undefined, { install });
        yield* on.service.admitEnable;
        expect(installs).toBe(1);

        const message = "Cua Driver installation failed during integrity.";
        const corrupt = yield* makeService(Effect.die("unused"), false, undefined, {
          install: Effect.fail(
            new CuaDriver.CuaDriverHostError({ operation: "install", cause: message }),
          ),
        });
        const failed = yield* Effect.flip(corrupt.service.admitEnable);
        expect([failed.operation, failed.message]).toEqual(["install", message]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "calls a Mac available only once the running driver reports both grants, on every start",
    () =>
      Effect.gen(function* () {
        const hosts = [yield* makeHost(), yield* makeHost()];
        let created = 0;
        let granted = { accessibility: true, screenRecording: true };
        const seen: Array<CuaDriverMcpConfiguration> = [];
        const { service } = yield* makeService(
          Effect.sync(() => hosts[created++]!.host),
          true,
          Effect.succeed({
            capability: "partial",
            reason: "Accessibility and Screen Recording must be granted at this Mac.",
            display: "console",
            environment: [],
          }),
          {
            observeGrants: (config) =>
              Effect.sync(() => {
                seen.push(config);
                return granted;
              }),
          },
        );
        expect((yield* service.status).display).toEqual({
          capability: "partial",
          reason: "Accessibility and Screen Recording must be granted at this Mac.",
          display: "console",
        });
        const first = yield* service.acquire.pipe(Effect.forkChild);
        yield* Deferred.succeed(hosts[0]!.ready, mcp);
        yield* Fiber.join(first);
        expect((yield* service.computerUse).capability).toBe("available");
        expect(seen).toEqual([mcp]);

        // Screen Recording is revoked; the next start checks again.
        granted = { accessibility: true, screenRecording: false };
        yield* Deferred.await(hosts[0]!.watching);
        yield* Deferred.succeed(hosts[0]!.exited, undefined);
        yield* Deferred.await(hosts[0]!.stopped);
        const second = yield* service.acquire.pipe(Effect.forkChild);
        yield* Deferred.succeed(hosts[1]!.ready, mcp);
        yield* Fiber.join(second);
        expect(yield* service.computerUse).toMatchObject({
          capability: "partial",
          reason:
            "Screen Recording is not granted at this Mac. Someone at the Mac must allow it in System Settings → Privacy & Security.",
        });
        expect(seen).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect("drops a Mac back to partial when the running driver cannot confirm its grants", () =>
    Effect.gen(function* () {
      const hosts = [yield* makeHost(), yield* makeHost()];
      let created = 0;
      const both = { accessibility: true, screenRecording: true };
      let answer: Effect.Effect<CuaDisplay.MacGrants | null> = Effect.succeed(both);
      let checks = 0;
      const { service } = yield* makeService(
        Effect.sync(() => hosts[created++]!.host),
        true,
        Effect.succeed({
          capability: "partial",
          reason: "Accessibility and Screen Recording must be granted at this Mac.",
          display: "console",
          environment: [],
        }),
        {
          observeGrants: () =>
            Effect.suspend(() => {
              checks++;
              return answer;
            }),
        },
      );
      const capability = service.computerUse.pipe(Effect.map((value) => value.capability));
      // Status re-checks a running driver once the last answer is ten seconds old.
      const recheck = (next: Effect.Effect<CuaDisplay.MacGrants | null>) =>
        Effect.sync(() => {
          answer = next;
        }).pipe(Effect.andThen(TestClock.adjust("10 seconds")));

      const first = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.succeed(hosts[0]!.ready, mcp);
      yield* Fiber.join(first);
      expect(yield* capability).toBe("available");

      yield* recheck(Effect.succeed(null));
      expect(yield* capability).toBe("partial");
      yield* recheck(Effect.succeed(both));
      expect(yield* capability).toBe("available");

      const unanswered = yield* Deferred.make<CuaDisplay.MacGrants | null>();
      yield* recheck(Deferred.await(unanswered));
      const timingOut = yield* capability.pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Fiber.join(timingOut)).toBe("partial");

      yield* recheck(Effect.succeed(both));
      expect(yield* capability).toBe("available");
      yield* Deferred.await(hosts[0]!.watching);
      yield* Deferred.succeed(hosts[0]!.exited, undefined);
      yield* Deferred.await(hosts[0]!.stopped);
      expect(yield* capability).toBe("partial");

      // A new daemon whose first check says nothing inherits nothing from the last one.
      answer = Effect.succeed(null);
      const second = yield* service.acquire.pipe(Effect.forkChild);
      yield* Deferred.succeed(hosts[1]!.ready, mcp);
      yield* Fiber.join(second);
      expect(yield* capability).toBe("partial");
      expect(checks).toBe(6);
    }).pipe(Effect.scoped),
  );
});
