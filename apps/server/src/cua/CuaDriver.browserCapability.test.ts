import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  ThreadId,
  type CuaDriverMcpConfiguration,
  type DesktopCuaDriverReport,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as CuaDriver from "./CuaDriver.ts";
import type * as CuaDisplay from "./CuaDisplayCapability.ts";
import { makeTestBrowserOriginGrants as makeBrowserOriginGrants } from "../preview/BrowserOriginGrants.testkit.ts";
import * as BrowserClaimManifest from "../preview/BrowserClaimManifest.ts";
import { makeBrowserDriverCapabilityProbe } from "./BrowserDriverCapabilityProbe.ts";
import { supportsBrowserClaims } from "./ComputerUseLeaseProxyBrowserClaims.ts";

const mcp: CuaDriverMcpConfiguration = { command: "/driver", args: [], environment: [] };
const testDisplay: CuaDisplay.CuaDisplayProbe = {
  capability: "available",
  reason: "test",
  environment: [],
};
const makeHost = Effect.fnUntraced(function* () {
  const watching = yield* Deferred.make<void>();
  const ready = yield* Deferred.make<CuaDriverMcpConfiguration, CuaDriver.CuaDriverError>();
  const exited = yield* Deferred.make<void, CuaDriver.CuaDriverError>();
  const stopped = yield* Deferred.make<void>();
  const host: CuaDriver.CuaDriverHost = {
    start: Deferred.await(ready),
    stop: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
    waitForExit: Deferred.succeed(watching, undefined).pipe(Effect.andThen(Deferred.await(exited))),
  };
  return { host, ready, exited, watching, stopped };
});
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
        Effect.map((sub) =>
          Stream.fromSubscription(sub).pipe(Stream.map((enableCua) => ({ ...values, enableCua }))),
        ),
      ),
    }),
  );
  return { service };
});

const fenceFixture = Effect.fn("CuaDriverTest.fenceFixture")(function* (
  stop: CuaDriver.CuaDriverHost["stop"],
) {
  const host = yield* makeHost();
  let capability = true;
  const grants = yield* makeBrowserOriginGrants({
    environmentId: EnvironmentId.make("environment:test"),
    supported: () => capability,
    publish: () => Effect.void,
    bind: () => Effect.die("not used"),
  });
  const { service } = yield* makeService(Effect.succeed({ ...host.host, stop }), true, undefined, {
    setDriverCapability: (value) =>
      Effect.sync(() => {
        capability = value;
      }),
  });
  const context = yield* Layer.build(BrowserClaimManifest.layer);
  const manifest = Context.get(context, BrowserClaimManifest.BrowserClaimManifest);
  yield* manifest.install(
    () => Effect.succeed("a".repeat(64)),
    Effect.succeed({}),
    service.fenceBrowserManifest,
  );
  yield* Deferred.succeed(host.ready, mcp);
  yield* service.acquire;
  yield* Deferred.await(host.watching);
  return { manifest, grants };
});

it.layer(ServerSettings.layerTest())("browser manifest driver fence", (it) => {
  it.effect("a manifest fence succeeds only after the active host stops", () =>
    Effect.gen(function* () {
      const { manifest } = yield* fenceFixture(Effect.void);
      if (!manifest.fence) return expect.fail("missing manifest fence");
      expect(yield* manifest.fence).toBe(true);
      expect(yield* manifest.fence).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("a host stop failure makes the manifest fence fail and disables claims", () =>
    Effect.gen(function* () {
      const { manifest, grants } = yield* fenceFixture(
        Effect.fail(new CuaDriver.CuaDriverHostError({ operation: "stop" })),
      );
      if (!manifest.fence) return expect.fail("missing manifest fence");
      expect(yield* manifest.fence).toBe(false);
      expect(
        (yield* grants.request({
          threadId: ThreadId.make("thread:test"),
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        })).status,
      ).toBe("refused");
    }).pipe(Effect.scoped),
  );

  it.effect("a host stop wait expiry makes the manifest fence fail and disables claims", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const finishStop = yield* Deferred.make<void>();
      const { manifest, grants } = yield* fenceFixture(
        Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(finishStop))),
      );
      if (!manifest.fence) return expect.fail("missing manifest fence");
      const fencing = yield* manifest.fence.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(stopping);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(fencing)).toBe(false);
      expect(
        (yield* grants.request({
          threadId: ThreadId.make("thread:test"),
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        })).status,
      ).toBe("refused");
      yield* Deferred.succeed(finishStop, undefined);
    }).pipe(Effect.scoped),
  );
  it.effect("an unacknowledged desktop stop makes the manifest fence fail", () =>
    Effect.gen(function* () {
      const reports = yield* PubSub.unbounded<DesktopCuaDriverReport>();
      const stopRequested = yield* Deferred.make<void>();
      const healthy = {
        status: "healthy" as const,
        lastSampleAt: Option.none(),
        lastError: Option.none(),
      };
      const factory = yield* CuaDriver.makeDesktopHostFactory().pipe(
        Effect.provide(
          DesktopTelemetryReceiver.layerTest({
            health: Effect.succeed(healthy),
            subscribeHealth: Effect.succeed({ latest: healthy, changes: Stream.empty }),
            cuaReports: Stream.fromPubSub(reports),
            requestCuaDriver: (requestId, enabled) =>
              enabled
                ? PubSub.publish(reports, {
                    version: 1,
                    type: "cuaDriverReport",
                    requestId,
                    status: "ready",
                    mcp,
                  }).pipe(Effect.asVoid)
                : Deferred.succeed(stopRequested, undefined).pipe(Effect.asVoid),
          }),
        ),
      );
      let capability = true;
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => capability,
        publish: () => Effect.void,
        bind: () => Effect.die("not used"),
      });
      const { service } = yield* makeService(factory, true, undefined, {
        setDriverCapability: (value) =>
          Effect.sync(() => {
            capability = value;
          }),
      });
      const context = yield* Layer.build(BrowserClaimManifest.layer);
      const manifest = Context.get(context, BrowserClaimManifest.BrowserClaimManifest);
      yield* manifest.install(
        () => Effect.succeed("a".repeat(64)),
        Effect.succeed({}),
        service.fenceBrowserManifest,
      );
      expect(Option.isSome(yield* service.acquire)).toBe(true);
      if (!manifest.fence) return expect.fail("missing manifest fence");
      const fencing = yield* manifest.fence.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(stopRequested);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(fencing)).toBe(false);
      expect(
        (yield* grants.request({
          threadId: ThreadId.make("thread:test"),
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        })).status,
      ).toBe("refused");
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
});

it.layer(ServerSettings.layerTest())("browser claim capability lifecycle", (it) => {
  it.effect.each([true, false])(
    "uses the running driver's tools list when support is %s",
    (supported) =>
      Effect.gen(function* () {
        const h = yield* makeHost();
        let capability = false;
        let probed = false;
        const grants = yield* makeBrowserOriginGrants({
          environmentId: EnvironmentId.make("environment:test"),
          supported: () => capability,
          publish: () => Effect.void,
          bind: () => Effect.die("not used"),
        });
        const { service } = yield* makeService(Effect.succeed(h.host), true, undefined, {
          probeBrowserClaims: () =>
            Effect.sync(() => {
              probed = true;
              return {
                tools: [
                  {
                    name: "get_browser_state",
                    inputSchema: { properties: supported ? { origin_scope: {} } : {} },
                  },
                ],
              };
            }),
          setDriverCapability: (value: boolean) =>
            Effect.sync(() => {
              capability = value;
            }),
        });
        yield* Deferred.succeed(h.ready, mcp);
        yield* service.acquire;
        yield* Deferred.await(h.watching);
        const result = yield* grants.request({
          threadId: ThreadId.make("thread:test"),
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        });
        expect(probed).toBe(true);
        expect(result.status).toBe(supported ? "pending" : "refused");
        if (result.status === "refused") expect(result.code).toBe("unavailable");
      }).pipe(Effect.scoped),
  );

  it.effect("fences claims until the replacement driver's probe completes", () =>
    Effect.gen(function* () {
      const first = yield* makeHost();
      const second = yield* makeHost();
      const newProbe = yield* Deferred.make<unknown>();
      const probeStarted = yield* Deferred.make<void>();
      const probeReported = yield* Deferred.make<void>();
      let capability = false;
      let generation = 0;
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => capability,
        publish: () => Effect.void,
        bind: () => Effect.die("not used"),
      });
      const input = {
        threadId: ThreadId.make("thread:test"),
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      };
      const tools = {
        tools: [{ name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } }],
      };
      const { service } = yield* makeService(
        () => Effect.succeed(generation++ === 0 ? first.host : second.host),
        true,
        undefined,
        {
          probeBrowserClaims: () =>
            generation === 1
              ? Effect.succeed(tools)
              : Deferred.succeed(probeStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(newProbe)),
                ),
          setDriverCapability: (value: boolean) =>
            Effect.sync(() => {
              capability = value;
            }).pipe(
              Effect.andThen(
                value && generation === 2
                  ? Deferred.succeed(probeReported, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
        },
      );
      yield* Deferred.succeed(first.ready, mcp);
      yield* service.acquire;
      yield* Deferred.await(first.watching);
      expect((yield* grants.request(input)).status).toBe("pending");
      yield* Deferred.succeed(first.exited, undefined);
      yield* Deferred.await(first.stopped);
      expect((yield* grants.request(input)).status).toBe("refused");
      yield* Deferred.succeed(second.ready, mcp);
      yield* service.acquire;
      yield* Deferred.await(second.watching);
      expect((yield* grants.request(input)).status).toBe("refused");
      yield* Deferred.succeed(newProbe, tools);
      yield* Deferred.await(probeStarted);
      yield* Deferred.await(probeReported);
      expect((yield* grants.request(input)).status).toBe("pending");
    }).pipe(Effect.scoped),
  );
});

it.live("probes a fake MCP driver's own tools list", () =>
  Effect.gen(function* () {
    const probe = yield* makeBrowserDriverCapabilityProbe();
    const script = `
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
        if (request.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } }] } }) + "\\n");
      });
    `;
    const result = yield* probe({
      command: process.execPath,
      args: ["-e", script],
      environment: [],
    });
    expect(supportsBrowserClaims(result)).toBe(true);
  }).pipe(Effect.provideService(HostProcess.Environment, {})),
);

it.layer(ServerSettings.layerTest())("browser manifest confirmation", (it) => {
  it.effect("rejects a configuration reply after the driver generation exits", () =>
    Effect.gen(function* () {
      const host = yield* makeHost();
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<unknown>();
      const { service } = yield* makeService(Effect.succeed(host.host), true, undefined, {
        readBrowserConfig: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      });
      yield* Deferred.succeed(host.ready, mcp);
      yield* service.acquire;
      yield* Deferred.await(host.watching);
      if (!service.readBrowserConfig) return expect.fail("missing config reader");
      const result = yield* service.readBrowserConfig.pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* Deferred.succeed(host.exited, undefined);
      yield* Deferred.await(host.stopped);
      yield* Deferred.succeed(reply, { capability_manifest: {} });
      expect(Exit.isFailure(yield* Fiber.join(result))).toBe(true);
    }).pipe(Effect.scoped),
  );
});
