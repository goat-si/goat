// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  GenerateMemorySummaryInput,
  MessageId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import type { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver } from "./driver.ts";

/** A probe that reports OpenCode 2 and a server start that fails once it is reached. */
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

const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

it.layer(layer)("OpenCodeDriver launch environment", (it) => {
  it.effect("memory follows a changed executable and caches its protocol", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const hostEnvironment = {
        PATH: "/old",
        HOME: root,
        XDG_DATA_HOME: root,
        OPENAI_API_KEY: "synthetic",
      };
      const host = yield* ProviderHost.ProviderHost;
      const probes: string[] = [];
      const launches: NodeJS.ProcessEnv[] = [];
      const runtime = {
        ...openCode2Runtime,
        runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
          Effect.sync(() => {
            const path = environment?.PATH ?? "";
            probes.push(path);
            return { stdout: path === "/old" ? "1.18.32" : "2.0.18", stderr: "", code: 0 };
          }),
        startOpenCodeServerProcess: ({
          environment,
        }: {
          readonly environment?: NodeJS.ProcessEnv;
        }) =>
          Effect.sync(() => launches.push(environment ?? {})).pipe(
            Effect.andThen(reachedServer("memory")),
          ),
      };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          environmentId: EnvironmentId.make("owner"),
        }),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        Effect.provideService(HostProcess.Environment, hostEnvironment),
        Effect.provideService(HostProcess.HomeDirectory, root),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      yield* instance.snapshot.resolveMaintenance();
      hostEnvironment.PATH = "/new";
      const input = GenerateMemorySummaryInput.make({
        cwd: root,
        sourceThread: {
          environmentId: EnvironmentId.make("source"),
          threadId: ThreadId.make("thread"),
        },
        sourceWatermark: {
          fromEventId: EventId.make("e1"),
          toEventId: EventId.make("e2"),
          throughSequence: 2,
        },
        messages: [{ messageId: MessageId.make("m1"), text: "hello", completed: true }],
        modelSelection: { instanceId: instance.instanceId, model: "openai/gpt-5" },
      });
      const wrongIdentity = {
        ...input,
        modelSelection: { ...input.modelSelection, instanceId: ProviderInstanceId.make("foreign") },
      };
      const denied = yield* instance.textGeneration.generateMemorySummary!(wrongIdentity).pipe(
        Effect.flip,
      );
      assert.deepInclude(denied.cause, { code: "identity_mismatch" });
      assert.strictEqual(probes.filter((path) => path === "/new").length, 0);
      yield* instance.textGeneration.generateMemorySummary!(input).pipe(Effect.flip);
      assert.strictEqual(probes.filter((path) => path === "/new").length, 1);
      assert.isDefined(launches.at(-1)?.OPENCODE_PASSWORD);
      yield* instance.textGeneration.generateMemorySummary!(input).pipe(Effect.flip);
      assert.strictEqual(probes.filter((path) => path === "/new").length, 1);
      assert.isDefined(launches.at(-1)?.OPENCODE_PASSWORD);
    }).pipe(Effect.scoped),
  );
  it.effect("maintenance follows PATH changes and caches unchanged paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const oldDir = `${root}/old`;
      const newDir = `${root}/new`;
      for (const dir of [oldDir, newDir]) {
        yield* fs.makeDirectory(dir);
        yield* fs.writeFileString(`${dir}/opencode`, "#!/bin/sh\n");
        yield* fs.chmod(`${dir}/opencode`, 0o755);
      }
      const host = { PATH: oldDir, HOME: root, XDG_DATA_HOME: root };
      const instance = yield* create({}, noHttp).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
      );
      const first = yield* instance.snapshot.resolveMaintenance();
      assert.strictEqual(first.installPath, `${oldDir}/opencode`);
      assert.strictEqual(
        (yield* instance.snapshot.resolveMaintenance()).installPath,
        first.installPath,
      );
      yield* fs.remove(`${oldDir}/opencode`);
      assert.notStrictEqual(
        (yield* instance.snapshot.resolveMaintenance()).installPath,
        first.installPath,
      );
      host.PATH = newDir;
      assert.strictEqual(
        (yield* instance.snapshot.resolveMaintenance()).installPath,
        `${newDir}/opencode`,
      );
    }).pipe(Effect.scoped),
  );
  it.effect(
    "regression #3079: a new OpenCode session uses the current host PATH and honors instance PATH",
    () =>
      Effect.gen(function* () {
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const host = { PATH: "/old", HOME: home, XDG_DATA_HOME: home };
        const launched: NodeJS.ProcessEnv[] = [];
        const runtime = {
          ...openCode2Runtime,
          startOpenCodeServerProcess: (input: { readonly environment?: NodeJS.ProcessEnv }) =>
            Effect.sync(() => launched.push(input.environment ?? {})).pipe(
              Effect.andThen(reachedServer("start")),
            ),
        };
        const make = (override: boolean) =>
          OpenCodeDriver.create({
            instanceId: ProviderInstanceId.make(override ? "path-override" : "path-inherited"),
            displayName: undefined,
            environment: override ? [{ name: "PATH", value: "/old", sensitive: false }] : [],
            enabled: true,
            config: OpenCodeDriver.defaultConfig(),
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, noHttp),
            Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
            Effect.provideService(HostProcess.Environment, host),
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
          );
        const inherited = yield* make(false);
        const overridden = yield* make(true);
        host.PATH = "/new";
        yield* inherited.snapshot.refresh;
        const open = (instance: typeof inherited) =>
          instance.orchestrationAdapter
            .openSession({
              threadId: ThreadId.make("path-thread"),
              providerSessionId: ProviderSessionId.make("path-session"),
              modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
              runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
            })
            .pipe(Effect.scoped, Effect.flip);
        yield* open(inherited);
        assert.strictEqual(launched.at(-1)?.PATH, "/new");
        yield* open(overridden);
        assert.strictEqual(launched.at(-1)?.PATH, "/old");
      }).pipe(Effect.scoped),
  );
  it.effect(
    "refreshes the probe environment after the host PATH changes while preserving instance overrides",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-opencode-path-" });
        const host = { PATH: "/usr/bin:/bin", HOME: home, XDG_DATA_HOME: home };
        const environments: NodeJS.ProcessEnv[] = [];
        const runtime = {
          ...openCode2Runtime,
          runOpenCodeCommand: ({ environment }: { readonly environment?: NodeJS.ProcessEnv }) =>
            Effect.sync(() => {
              environments.push(environment ?? {});
              return { stdout: "opencode v2.0.18\n", stderr: "", code: 0 };
            }),
        };
        const makeInstance = (override: boolean) =>
          OpenCodeDriver.create({
            instanceId: ProviderInstanceId.make(override ? "override" : "inherited"),
            displayName: undefined,
            environment: override
              ? [{ name: "PATH", value: "/usr/bin:/bin", sensitive: false }]
              : [],
            enabled: true,
            config: OpenCodeDriver.defaultConfig(),
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, noHttp),
            Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
            Effect.provideService(HostProcess.Environment, host),
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provide(TestProviderHost.layer({ runBackgroundWork: false })),
          );
        const inherited = yield* makeInstance(false);
        const overridden = yield* makeInstance(true);
        host.PATH = "/new/bin:/usr/bin:/bin";
        yield* inherited.snapshot.refresh;
        assert.strictEqual(environments.at(-1)?.PATH, "/new/bin:/usr/bin:/bin");
        assert.strictEqual(environments.at(-1)?.MISE_OFFLINE, "1");
        assert.strictEqual(Object.getPrototypeOf(environments.at(-1)), Object.prototype);
        yield* overridden.snapshot.refresh;
        assert.strictEqual(environments.at(-1)?.PATH, "/usr/bin:/bin");
      }).pipe(Effect.scoped),
  );
});
