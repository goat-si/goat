// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OPENCODE_2_RESPONSES, replayOpenCodeServer } from "./probeResponses.fixture.ts";
import { OpenCodeDriver, isLocalOpenCodeServerUrl } from "./driver.ts";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";

it("only probes a locally configured OpenCode server's installed CLI", () => {
  assert.isTrue(isLocalOpenCodeServerUrl("http://127.0.0.1:35768"));
  assert.isTrue(isLocalOpenCodeServerUrl("http://127.255.255.254:4096"));
  assert.isFalse(isLocalOpenCodeServerUrl("http://127.example.com:4096"));
  assert.isFalse(isLocalOpenCodeServerUrl("http://128.0.0.1:4096"));
  assert.isTrue(isLocalOpenCodeServerUrl("http://localhost:4096"));
  assert.isTrue(isLocalOpenCodeServerUrl("http://[::1]:4096"));
  assert.isFalse(isLocalOpenCodeServerUrl("https://remote.example.com:4096"));
  assert.isFalse(isLocalOpenCodeServerUrl(""));
  assert.isFalse(isLocalOpenCodeServerUrl("file:///tmp/opencode"));
});

const reachedServer = (operation: string) =>
  Effect.fail(
    new OpenCodeRuntime.OpenCodeRuntimeError({ operation, detail: "reached a 1.x server path" }),
  );
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(HostProcess.HomeDirectory, "/fixture/opencode-test"),
  Layer.succeed(HostProcess.Environment, {
    HOME: "/fixture/opencode-test",
    XDG_DATA_HOME: "/fixture/opencode-test",
    PATH: [NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(NodePath.delimiter),
  }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient, enabled = true) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

it.layer(layer)("OpenCode loopback server CLI probe", (it) => {
  it.effect.each(["2.1.2", null])(
    "reports the installed CLI version independently of the loopback server (%s)",
    (installedVersion) =>
      Effect.gen(function* () {
        const probeOffline: Array<string | undefined> = [];
        const runtime = {
          ...openCode2Runtime,
          runOpenCodeCommand: (input) =>
            Effect.sync(() => {
              probeOffline.push(input.environment?.MISE_OFFLINE);
              return {
                stdout:
                  installedVersion === null ? "unrecognized" : `opencode v${installedVersion}\n`,
                stderr: "",
                code: 0,
              };
            }),
        } as OpenCodeRuntime.OpenCodeRuntime["Service"];
        const instance = yield* create(
          { serverUrl: "http://127.0.0.1:4096" },
          replayOpenCodeServer(OPENCODE_2_RESPONSES, ""),
        ).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));

        const snapshot = yield* instance.snapshot.refresh;
        assert.strictEqual(snapshot.version, "2.0.18");
        assert.strictEqual(snapshot.installedVersion, installedVersion ?? undefined);
        const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(maintenance.packageName, "@opencode/cli");
        assert.isNotEmpty(probeOffline);
        assert.isTrue(probeOffline.every((offline) => offline === "1"));
      }).pipe(Effect.scoped),
  );

  it.effect("skips the installed CLI probe when a localhost provider is disabled", () =>
    Effect.gen(function* () {
      const probed: string[] = [];
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: () =>
          Effect.sync(() => {
            probed.push("--version");
            return { stdout: "opencode v2.1.2\n", stderr: "", code: 0 };
          }),
      } as OpenCodeRuntime.OpenCodeRuntime["Service"];
      const instance = yield* create({ serverUrl: "http://127.0.0.1:4096" }, noHttp, false).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
      );

      const snapshot = yield* instance.snapshot.refresh;
      assert.isFalse(snapshot.enabled);
      assert.deepStrictEqual(probed, []);
    }).pipe(Effect.scoped),
  );
});
