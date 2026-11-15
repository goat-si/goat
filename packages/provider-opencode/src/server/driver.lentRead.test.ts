// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver } from "./driver.ts";
import {
  OPENCODE_2_RESPONSES,
  OPENCODE_2_WORKSPACE_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";

const HOME = "/fixture/opencode-lent-read";

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }),
  Layer.succeed(HostProcess.HomeDirectory, HOME),
  Layer.succeed(HostProcess.Environment, {
    HOME,
    XDG_DATA_HOME: HOME,
    PATH: [NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(NodePath.delimiter),
  }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, {
    runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("OpenCode 2 model read on a lent server", (it) => {
  it.effect("a read that never answers ends at 20 seconds with no models listed yet", () =>
    Effect.gen(function* () {
      const replay = replayOpenCodeServer(
        { ...OPENCODE_2_RESPONSES, ...OPENCODE_2_WORKSPACE_RESPONSES },
        "secret",
      );
      const server = HttpClient.make((request) =>
        new URL(request.url).pathname === "/api/model" ? Effect.never : replay.execute(request),
      );
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-lent-read"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: {
          ...OpenCodeDriver.defaultConfig(),
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "secret",
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, server));
      const first = yield* Stream.runHead(instance.snapshot.streamChanges).pipe(Effect.forkChild);
      yield* TestClock.adjust("19999 millis");
      assert.isUndefined(first.pollUnsafe());
      yield* TestClock.adjust("1 millis");

      const published = Option.getOrThrow(yield* Fiber.join(first));
      assert.strictEqual(published.status, "warning");
      assert.strictEqual(
        published.message,
        "OpenCode 2 is running, but it did not list any models yet.",
      );
      assert.deepStrictEqual(published.models, []);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
