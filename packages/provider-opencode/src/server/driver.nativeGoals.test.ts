// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

/** Each PATH is one launch with its own server: what `opencode --version` says, what servers report. */
interface Launches {
  readonly probe: Record<string, string>;
  /** The version each successive server start under that PATH reports. */
  readonly servers: Record<string, ReadonlyArray<string>>;
}
const PORTS: Record<string, string> = { "/a": "4001", "/b": "4002" };
// The instance's probe server (MISE_OFFLINE) for a launch, kept apart from session servers.
const PROBE_PORTS: Record<string, string> = { "/a": "5001", "/b": "5002" };

/**
 * One instance whose sessions launch per PATH. `dropStream(path)` ends that server's event stream
 * and resolves once the reconnected stream is read, which the adapter does only after storing the
 * reconnect's capabilities. `holdOpen(path)` makes the next session open under that PATH wait.
 */
const goalHarness = (host: NodeJS.ProcessEnv, launches: Launches) =>
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
      Object.keys(PORTS).find((path) => PORTS[path] === port || PROBE_PORTS[path] === port) ?? "/a";
    const served = new Map<string, string>();
    const running = new Map<string, boolean>();
    const starts = new Map<string, number>();
    const closers = new Map<string, () => void>();
    const reread = new Map<string, () => void>();
    const held = new Map<string, Promise<void>>();
    const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      const path = pathOfPort(url.port);
      if (url.pathname === "/api/info")
        return json(request, {
          ...JSON.parse(OPENCODE_2_RESPONSES["/api/info"].body),
          version: served.get(url.port),
        });
      if (url.pathname === "/api/model") {
        const gate = held.get(path);
        const answer = json(request, { location: { directory: "/work" }, data: [] });
        return gate === undefined
          ? answer
          : Effect.promise(() => gate).pipe(Effect.andThen(answer));
      }
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
          stdout: `opencode v${launches.probe[environment?.PATH ?? "/a"]}`,
          stderr: "",
          code: 0,
        }),
      startOpenCodeServerProcess: ({
        environment,
        verify,
      }: Parameters<OpenCodeRuntime.OpenCodeRuntime["Service"]["startOpenCodeServerProcess"]>[0]) =>
        Effect.gen(function* () {
          const path = environment?.PATH ?? "/a";
          const probe = environment?.MISE_OFFLINE === "1";
          const port = (probe ? PROBE_PORTS : PORTS)[path] ?? "0";
          if (probe) served.set(port, launches.probe[path] ?? "0.0.0");
          else {
            const start = starts.get(path) ?? 0;
            starts.set(path, start + 1);
            const versions = launches.servers[path] ?? [];
            served.set(port, versions[Math.min(start, versions.length - 1)] ?? "0.0.0");
          }
          running.set(port, true);
          const url = "http://127.0.0.1:" + port;
          const version = verify ? yield* verify(url) : (served.get(port) ?? "0.0.0");
          return {
            url,
            version,
            isRunning: Effect.sync(() => running.get(port) === true),
            exitCode: Effect.never,
          };
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
    const holdOpen = (path: string) =>
      Effect.sync(() => {
        let release = () => {};
        held.set(path, new Promise<void>((resolve) => (release = resolve)));
        return Effect.sync(() => {
          held.delete(path);
          release();
        });
      });
    const stopServer = (path: string) => Effect.sync(() => running.set(PORTS[path] ?? "0", false));
    const supportsGoals = Effect.map(
      instance.orchestrationAdapter.getCapabilities(),
      (capabilities) => capabilities.turns.supportsNativeGoals === true,
    );
    return { instance, open, dropStream, holdOpen, stopServer, supportsGoals };
  });

const plain: Launches = {
  probe: { "/a": "2.2.4", "/b": "2.2.5" },
  servers: { "/a": ["2.2.4"], "/b": ["2.2.5"] },
};
// A shim whose probe still names 2.2.4 while the server it starts is 2.2.5.
const shim: Launches = {
  probe: { "/a": "2.2.4", "/b": "2.2.4" },
  servers: { "/a": ["2.2.4"], "/b": ["2.2.5", "2.2.4"] },
};

it.layer(layer)("OpenCode native goal support", (it) => {
  it.effect("an older session reconnecting does not withdraw support the current launch has", () =>
    Effect.gen(function* () {
      const host: NodeJS.ProcessEnv = { PATH: "/a", HOME: "/fixture" };
      const { open, dropStream, supportsGoals } = yield* goalHarness(host, plain);
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
        const { instance, open, dropStream, supportsGoals } = yield* goalHarness(host, plain);
        yield* open("goals-b");
        host.PATH = "/a";
        yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isFalse(yield* supportsGoals);
        yield* dropStream("/b");
        assert.isFalse(yield* supportsGoals);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "an older session finishing its open after a newer one does not replace the newer answer",
    () =>
      Effect.gen(function* () {
        const host: NodeJS.ProcessEnv = { PATH: "/a", HOME: "/fixture" };
        const { open, holdOpen, supportsGoals } = yield* goalHarness(host, shim);
        const release = yield* holdOpen("/a");
        const opening = yield* open("goals-a").pipe(Effect.forkChild({ startImmediately: true }));
        host.PATH = "/b";
        yield* open("goals-b");
        assert.isTrue(yield* supportsGoals);
        yield* release;
        yield* Fiber.join(opening);
        assert.isTrue(yield* supportsGoals);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "support follows the running server when the same launch restarts on another version",
    () =>
      Effect.gen(function* () {
        const host: NodeJS.ProcessEnv = { PATH: "/b", HOME: "/fixture" };
        const { open, dropStream, stopServer, supportsGoals } = yield* goalHarness(host, shim);
        yield* open("goals-b");
        assert.isTrue(yield* supportsGoals);
        // Its stream drops and the reconnect finds the server gone, so it starts another.
        yield* stopServer("/b");
        yield* dropStream("/b");
        assert.isFalse(yield* supportsGoals);
      }).pipe(Effect.scoped),
  );
});
