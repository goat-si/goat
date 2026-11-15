import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import type { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver } from "./driver.ts";

const reachedServer = (operation: string) =>
  Effect.fail(new OpenCodeRuntime.OpenCodeRuntimeError({ operation, detail: "expected stop" }));
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "2.0.18", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));
const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

it.layer(layer)("OpenCode runtime profile selection", (it) => {
  it.effect("selects the protocol for the executable used by each new session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const host = { HOME: home, XDG_DATA_HOME: home, PATH: "/v2" };
      const probes: string[] = [];
      const launches: Array<{ generation: string; path: string | undefined }> = [];
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
          Effect.sync(() => {
            probes.push(environment?.PATH ?? "");
            return {
              stdout: environment?.PATH === "/v2" ? "2.0.18" : "1.18.32",
              stderr: "",
              code: 0,
            };
          }),
        startOpenCodeServerProcess: ({
          environment,
        }: {
          readonly environment?: NodeJS.ProcessEnv;
        }) =>
          Effect.sync(() => launches.push({ generation: "v2", path: environment?.PATH })).pipe(
            Effect.andThen(
              Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "v2",
                  detail: "expected stop",
                }),
              ),
            ),
          ),
        connectToOpenCodeServer: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
          Effect.sync(() => launches.push({ generation: "v1", path: environment?.PATH })).pipe(
            Effect.andThen(
              Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "v1",
                  detail: "expected stop",
                }),
              ),
            ),
          ),
      };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      const open = instance.orchestrationAdapter
        .openSession({
          threadId: ThreadId.make("switch-thread"),
          providerSessionId: ProviderSessionId.make("switch-session"),
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        })
        .pipe(Effect.scoped, Effect.flip);
      yield* open;
      assert.deepStrictEqual(launches.at(-1), { generation: "v2", path: "/v2" });
      yield* open;
      assert.deepStrictEqual(launches.at(-1), { generation: "v2", path: "/v2" });
      assert.strictEqual(probes.length, 1);
      host.PATH = "/v1";
      yield* open;
      assert.deepStrictEqual(launches.at(-1), { generation: "v1", path: "/v1" });
      yield* open;
      assert.deepStrictEqual(launches.at(-1), { generation: "v1", path: "/v1" });
      assert.strictEqual(probes.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("a session launches with the environment captured for its version probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const host = { HOME: home, XDG_DATA_HOME: home, PATH: "/v2" };
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const launches: NodeJS.ProcessEnv[] = [];
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
          environment?.MISE_OFFLINE === "1"
            ? Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "offline",
                  detail: "not installed",
                }),
              )
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ stdout: "2.0.18", stderr: "", code: 0 }),
              ),
        startOpenCodeServerProcess: ({
          environment,
        }: {
          readonly environment?: NodeJS.ProcessEnv;
        }) =>
          Effect.sync(() => launches.push(environment ?? {})).pipe(
            Effect.andThen(
              Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "v2",
                  detail: "expected stop",
                }),
              ),
            ),
          ),
      };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      const session = yield* instance.orchestrationAdapter
        .openSession({
          threadId: ThreadId.make("capture-thread"),
          providerSessionId: ProviderSessionId.make("capture-session"),
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        })
        .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      host.PATH = "/v1";
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(session);
      assert.strictEqual(launches.at(-1)?.PATH, "/v2");
    }).pipe(Effect.scoped),
  );

  it.effect("reprobes when the executable at an unchanged path is replaced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const binary = `${home}/opencode`;
      yield* fs.writeFileString(binary, "v2");
      yield* fs.chmod(binary, 0o755);
      let version = "2.0.18";
      const selected: string[] = [];
      const stopped = new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "fixture",
        detail: "expected stop",
      });
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: () => Effect.sync(() => ({ stdout: version, stderr: "", code: 0 })),
        startOpenCodeServerProcess: () =>
          Effect.sync(() => selected.push("v2")).pipe(Effect.andThen(Effect.fail(stopped))),
        connectToOpenCodeServer: () =>
          Effect.sync(() => selected.push("v1")).pipe(Effect.andThen(Effect.fail(stopped))),
      };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          XDG_DATA_HOME: home,
          PATH: home,
        }),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      const open = instance.orchestrationAdapter
        .openSession({
          threadId: ThreadId.make("replace-thread"),
          providerSessionId: ProviderSessionId.make("replace-session"),
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        })
        .pipe(Effect.scoped, Effect.flip);
      yield* open;
      assert.strictEqual(selected.at(-1), "v2");
      version = "1.18.32";
      yield* fs.writeFileString(binary, "v1 replacement with different size");
      yield* open;
      assert.strictEqual(selected.at(-1), "v1");
    }).pipe(Effect.scoped),
  );

  it.effect("does not launch an executable replaced during its version probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const binary = `${home}/opencode`;
      yield* fs.writeFileString(binary, "v2");
      yield* fs.chmod(binary, 0o755);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const launches: string[] = [];
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
          environment?.MISE_OFFLINE === "1"
            ? Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "offline",
                  detail: "not installed",
                }),
              )
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ stdout: "2.0.18", stderr: "", code: 0 }),
              ),
        startOpenCodeServerProcess: () =>
          Effect.sync(() => launches.push("v2")).pipe(Effect.andThen(reachedServer("start"))),
        connectToOpenCodeServer: () =>
          Effect.sync(() => launches.push("v1")).pipe(Effect.andThen(reachedServer("connect"))),
      };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          XDG_DATA_HOME: home,
          PATH: home,
        }),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      const opening = yield* instance.orchestrationAdapter
        .openSession({
          threadId: ThreadId.make("replaced-thread"),
          providerSessionId: ProviderSessionId.make("replaced-session"),
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        })
        .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* fs.writeFileString(binary, "replacement with different size");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(opening);
      assert.deepStrictEqual(launches, []);
    }).pipe(Effect.scoped),
  );
});
