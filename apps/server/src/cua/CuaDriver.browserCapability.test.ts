import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type CuaDriverMcpConfiguration } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";
import type * as CuaDisplay from "./CuaDisplayCapability.ts";
import { makeBrowserOriginGrants } from "../preview/BrowserOriginGrants.ts";
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
