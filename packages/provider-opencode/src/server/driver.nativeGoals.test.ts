// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver } from "./driver.ts";
import { OPENCODE_2_RESPONSES } from "./probeResponses.fixture.ts";

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

/** PATH /a launches OpenCode 2.2.4 on one server, PATH /b 2.2.5 on another. */
const VERSIONS: Record<string, string> = { "/a": "2.2.4", "/b": "2.2.5" };
const PORTS: Record<string, string> = { "/a": "4001", "/b": "4002" };

/**
 * One instance whose sessions launch per PATH, and a way to make a server's event stream end once:
 * `dropStream(path)` closes that server's stream and resolves once the reconnected stream is read,
 * which the adapter does only after the reconnect has stored the server's capabilities.
 */
const goalHarness = (host: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-goal-identity-" });
    const binaryPath = NodePath.join(
      root,
      "lib",
      "node_modules",
      "@opencode",
      "cli",
      "bin",
      "opencode",
    );
    yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
    yield* fs.writeFileString(binaryPath, "");
    const pathOfPort = (port: string) =>
      Object.keys(PORTS).find((path) => PORTS[path] === port) ?? "/a";
    const closers = new Map<string, () => void>();
    const reread = new Map<string, () => void>();
    const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      const path = pathOfPort(url.port);
      if (url.pathname === "/api/info")
        return json(request, {
          ...JSON.parse(OPENCODE_2_RESPONSES["/api/info"].body),
          version: VERSIONS[path],
        });
      if (url.pathname === "/api/model")
        return json(request, { location: { directory: "/work" }, data: [] });
      if (url.pathname === "/api/event") {
        const signal = reread.get(path);
        const body =
          signal === undefined
            ? new ReadableStream({
                start: (controller) => void closers.set(path, () => controller.close()),
              })
            : new ReadableStream({ pull: () => signal() }, { highWaterMark: 0 });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, { headers: { "content-type": "text/event-stream" } }),
          ),
        );
      }
      return Effect.die(`Unexpected request: ${url.pathname}`);
    });
    const runtime = {
      runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
        Effect.succeed({
          stdout: `opencode v${VERSIONS[environment?.PATH ?? "/a"]}`,
          stderr: "",
          code: 0,
        }),
      startOpenCodeServerProcess: ({
        environment,
        verify,
      }: Parameters<OpenCodeRuntime.OpenCodeRuntime["Service"]["startOpenCodeServerProcess"]>[0]) =>
        Effect.gen(function* () {
          const url = `http://127.0.0.1:${PORTS[environment?.PATH ?? "/a"]}`;
          const version = verify ? yield* verify(url) : VERSIONS[environment?.PATH ?? "/a"];
          return { url, version, isRunning: Effect.succeed(true), exitCode: Effect.never };
        }),
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
    const instance = yield* OpenCodeDriver.create({
      instanceId: ProviderInstanceId.make("opencode-goals"),
      displayName: undefined,
      environment: [],
      enabled: true,
      config: { ...OpenCodeDriver.defaultConfig(), binaryPath },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
      Effect.provideService(HostProcess.Environment, host),
      Effect.provideService(HostProcess.HomeDirectory, root),
    );
    const open = (name: string) =>
      instance.orchestrationAdapter.openSession({
        threadId: ThreadId.make(name),
        providerSessionId: ProviderSessionId.make(name),
        modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
      });
    const dropStream = (path: string) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            reread.set(path, resolve);
            closers.get(path)?.();
          }),
      );
    const supportsGoals = Effect.map(
      instance.orchestrationAdapter.getCapabilities(),
      (capabilities) => capabilities.turns.supportsNativeGoals === true,
    );
    return { instance, open, dropStream, supportsGoals };
  });

it.layer(layer)("OpenCode native goal support", (it) => {
  it.effect("an older session reconnecting does not withdraw support the current launch has", () =>
    Effect.gen(function* () {
      const host: NodeJS.ProcessEnv = { PATH: "/a", HOME: "/fixture" };
      const { open, dropStream, supportsGoals } = yield* goalHarness(host);
      const a = yield* open("goals-a");
      host.PATH = "/b";
      const b = yield* open("goals-b");
      // What decides a goal in a running session is that session's own server.
      assert.isFalse(a.providerSession.capabilities.turns.supportsNativeGoals);
      assert.isTrue(b.providerSession.capabilities.turns.supportsNativeGoals);
      assert.isTrue(yield* supportsGoals);
      yield* dropStream("/a");
      assert.isTrue(yield* supportsGoals);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an older supporting session reconnecting does not grant support the current launch lacks",
    () =>
      Effect.gen(function* () {
        const host: NodeJS.ProcessEnv = { PATH: "/b", HOME: "/fixture" };
        const { instance, open, dropStream, supportsGoals } = yield* goalHarness(host);
        yield* open("goals-b");
        host.PATH = "/a";
        yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isFalse(yield* supportsGoals);
        yield* dropStream("/b");
        assert.isFalse(yield* supportsGoals);
      }).pipe(Effect.scoped),
  );
});
