import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as Config from "../../config.ts";
import * as Settings from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as Factory from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as TokenBroker from "../CodexManagedTokenBroker.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Installation from "../CodexInstallation.ts";
import { codexHomeRouteArgv } from "../CodexHomeRouteConfig.ts";
import * as HomeRoute from "../OpenCodexRoute.ts";
import * as Host from "../ProviderHostLive.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ResetCredit from "../resetCreditCoordinator.ts";
import { CodexDriver } from "./CodexDriver.ts";
const dependencies = Config.layerTest(process.cwd(), { prefix: "codex-home-driver-" }).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      IdAllocator.layer,
      McpProviderSessions.layer,
      MemoryDerivedCache.layer,
      Settings.layerTest(),
      ModelManifest.layerTest,
      ResetCredit.layerTest,
      ProviderLatestVersions.layer,
    ),
  ),
  Layer.provideMerge(
    Layer.mock(Factory.CodexAppServerClientFactory)({
      open: () => Effect.die("Disabled instances do not launch"),
    }),
  ),
  Layer.provideMerge(Layer.mock(Installation.CodexInstallation)({ managedDirectory: "unused" })),
  Layer.provideMerge(Layer.mock(Secrets.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(TokenBroker.CodexManagedTokenBroker)({
      endpoint: Effect.succeed("unused-private-pipe"),
      awaitIdle: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-home")),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No HTTP for disabled instances")),
    ),
  ),
);
// Any token broker or secret store access fails these tests.
const withoutSignIn = Host.layer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(Layer.mock(TokenBroker.CodexManagedTokenBroker)({})),
  Layer.provideMerge(Layer.mock(Secrets.ServerSecretStore)({})),
);
const managedHome = (opencodexAuth: "openai" | "none") => ({
  ...CodexDriver.defaultConfig(),
  setupMode: "managed" as const,
  modelRoute: "opencodex" as const,
  opencodexAuth,
});
it.effect("refuses managed Home with OpenAI authentication before preparing a sign-in", () =>
  Effect.gen(function* () {
    const result = yield* CodexDriver.create({
      instanceId: ProviderInstanceId.make("managed-home-openai"),
      displayName: "Managed Home",
      environment: [],
      enabled: false,
      config: managedHome("openai"),
    }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.include(result.failure.message, "OpenAI authentication for Home is available");
  }).pipe(
    Effect.provide(withoutSignIn),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Refused instances must not launch")),
    ),
  ),
);
it.effect("creates managed Home None without a ChatGPT sign-in, token broker or reset credit", () =>
  Effect.gen(function* () {
    const instance = yield* CodexDriver.create({
      instanceId: ProviderInstanceId.make("child-codex"),
      displayName: "Child Codex",
      environment: [],
      enabled: false,
      config: managedHome("none"),
    });
    assert.isUndefined(instance.auth);
    assert.isUndefined(instance.consumeResetCredit);
    assert.equal((yield* instance.snapshot.getSnapshot).setup?.canAuthenticate, false);
  }).pipe(
    Effect.provide(withoutSignIn),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Disabled instance must not launch")),
    ),
  ),
);
it.live("reports an enabled managed Home None instance ready without a provider account", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "managed-home-ready-" });
    const catalog = path.join(root, "opencodex-catalog.json");
    yield* fs.writeFileString(catalog, '{"models":[]}');
    yield* fs.makeDirectory(path.join(root, "home"));
    const log = path.join(root, "methods.jsonl");
    // Boundary peer: applies GOAT's -c overrides to config/read as Codex's loader does.
    const binary = writeFakeCli({
      directory: path.join(root, "bin"),
      name: "codex",
      source: [
        'import fs from "node:fs";',
        'import readline from "node:readline";',
        `import { parse } from ${JSON.stringify(import.meta.resolve("smol-toml"))};`,
        "const config = {};",
        "const args = process.argv.slice(2);",
        'args.forEach((arg, index) => { if (args[index - 1] === "-c") Object.assign(config, parse(arg)); });',
        'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
        "  const { id, method } = JSON.parse(line);",
        "  if (id === undefined) return;",
        `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(method) + "\\n");`,
        "  const result =",
        '    method === "initialize" ? { userAgent: "codex/0.156.1", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" }',
        '    : method === "config/read" ? { config, origins: {} }',
        '    : method === "account/read" ? { account: null, requiresOpenaiAuth: false }',
        '    : method === "model/list" ? { data: [], nextCursor: null }',
        '    : method === "skills/list" ? { data: [] } : undefined;',
        '  process.stdout.write(JSON.stringify(result === undefined ? { id, error: { code: -32601, message: "unsupported" } } : { id, result }) + "\\n");',
        "});",
      ].join("\n"),
    });
    const executable = {
      executablePath: binary,
      version: "0.156.1",
      source: "managed" as const,
      managedVersionDirectory: path.join(root, "bin"),
    };
    const instance = yield* CodexDriver.create({
      instanceId: ProviderInstanceId.make("child-codex"),
      displayName: "Child Codex",
      environment: [],
      enabled: true,
      config: { ...managedHome("none"), homePath: path.join(root, "home") },
    }).pipe(
      Effect.provide(
        Layer.mock(Installation.CodexInstallation)({
          managedDirectory: path.join(root, "bin"),
          resolve: (options) =>
            options?.managedOnly ? Effect.succeed(executable) : Effect.die("PATH Codex used"),
        }),
      ),
      Effect.provideService(HomeRoute.OpenCodexRoute, {
        inspect: () => Effect.succeed({ modelRoute: "opencodex", state: "home" }),
        launchArgs: (input) =>
          Effect.succeed(
            codexHomeRouteArgv(input.settings, input.settings.opencodexBaseUrl, catalog),
          ),
        requireAvailable: () => Effect.void,
      }),
    );
    const snapshot = yield* instance.snapshot.refresh;
    assert.equal(snapshot.status, "ready", snapshot.message);
    assert.notEqual(snapshot.auth.status, "authenticated");
    assert.equal(snapshot.setup?.canAuthenticate, false);
    assert.equal(snapshot.codexRoute?.effectiveBaseUrl, "http://127.0.0.1:10100/v1");
    const methods = (yield* fs.readFileString(log)).trim().split("\n");
    assert.includeMembers(methods, ['"config/read"', '"account/read"']);
  }).pipe(Effect.provide(withoutSignIn)),
);
it.effect(
  "does not expose reset credit redemption for a Home route and preserves continuation identity for the same home",
  () =>
    Effect.gen(function* () {
      const config = { ...CodexDriver.defaultConfig(), homePath: "/same-codex-home" };
      const own = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-own"),
        displayName: "Own account",
        environment: [],
        enabled: false,
        config,
      });
      const home = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-home"),
        displayName: "Home",
        environment: [],
        enabled: false,
        config: { ...config, modelRoute: "opencodex" },
      });
      assert.isDefined(own.consumeResetCredit);
      assert.isUndefined(home.consumeResetCredit);
      assert.deepStrictEqual(home.continuationIdentity, own.continuationIdentity);
    }).pipe(
      Effect.provide(Host.layer.pipe(Layer.provideMerge(dependencies))),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("No provider process should launch")),
      ),
    ),
);
