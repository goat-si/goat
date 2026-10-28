import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type OpenCodexInventorySnapshot,
  type ProviderInstanceEnvironment,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "../config.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Runner from "../processRunner.ts";
import { inspectProviderHomeRuntime, prepareProviderHomeRuntime } from "./ProviderHomeRuntime.ts";

const HOME = "http://127.0.0.1:10100/v1";
const instanceId = ProviderInstanceId.make("home-runtime");
const piExport = {
  providers: {
    opencodex: {
      baseUrl: HOME,
      api: "openai-completions",
      apiKey: "fixture-placeholder",
      models: [{ id: "provider/model", name: "Home model" }],
    },
  },
};
const openCodeExport = {
  provider: {
    opencodex: {
      options: { baseURL: HOME, apiKey: "{env:OPENCODEX_API_KEY}" },
      models: { "provider/model": {} },
    },
  },
  providers: {
    opencodex: { settings: { baseURL: HOME }, models: { "provider/model": {} } },
  },
};
type Output = Partial<Runner.ProcessRunOutput>;

/** The local OpenCodex boundary: its inventory read and the export subprocess. */
const boundary = (
  stdout: unknown,
  options: {
    readonly output?: Output;
    readonly inventory?: Partial<OpenCodexInventorySnapshot>;
  } = {},
) => {
  const calls: Array<Runner.ProcessRunInput> = [];
  const snapshot = fleetSnapshot("mac-studio");
  const layer = Layer.mergeAll(
    Layer.mock(Inventory.OpenCodexInventory)({
      readParity: Effect.succeed({
        ...snapshot,
        binaries: [{ path: "/fixture/ocx", version: "2.92.0" }],
        ...options.inventory,
      }),
    }),
    Layer.mock(Runner.ProcessRunner)({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input);
          const document = typeof stdout === "function" ? stdout() : stdout;
          return {
            stdout: typeof document === "string" ? document : JSON.stringify(document),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
            ...options.output,
          };
        }),
    }),
    Config.layerTest(process.cwd(), { prefix: "provider-home-runtime-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return { calls, layer };
};
const prepare = (
  driver: "claudeAgent" | "opencode" | "pi",
  config: Readonly<Record<string, unknown>>,
  environment: ProviderInstanceEnvironment = [],
) =>
  prepareProviderHomeRuntime(
    driver,
    instanceId,
    { modelRoute: "opencodex", opencodexBaseUrl: HOME, ...config },
    environment,
  ).pipe(Effect.provideService(HostProcess.Environment, {}));
const variable = (environment: ProviderInstanceEnvironment, name: string) =>
  environment.find((entry) => entry.name === name)?.value;

it.effect(
  "writes routed Pi configuration to a durable GOAT directory and keeps the user's sessions",
  () => {
    const { calls, layer } = boundary(piExport);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const user = yield* fs.makeTempDirectoryScoped({ prefix: "pi-user-fixture-" });
      yield* fs.writeFileString(path.join(user, "models.json"), "user configuration");
      const userDir = [{ name: "PI_CODING_AGENT_DIR", value: user, sensitive: false }];
      const first = yield* prepare("pi", {}, userDir);
      // The instance is re-created on reconnect or restart; native sessions must still resolve.
      const second = yield* prepare("pi", {}, userDir);
      const directory = variable(first.environment, "PI_CODING_AGENT_DIR");
      assert.isDefined(directory);
      if (directory === undefined) return;
      assert.notEqual(directory, user);
      assert.equal(variable(second.environment, "PI_CODING_AGENT_DIR"), directory);
      assert.equal(
        variable(first.environment, "PI_CODING_AGENT_SESSION_DIR"),
        path.join(user, "sessions"),
      );
      assert.equal(
        variable(second.environment, "PI_CODING_AGENT_SESSION_DIR"),
        path.join(user, "sessions"),
      );
      const models = JSON.parse(yield* fs.readFileString(path.join(directory, "models.json")));
      assert.equal(models.providers.opencodex.baseUrl, HOME);
      assert.equal(models.providers.opencodex.apiKey, "opencodex-loopback");
      assert.deepEqual(
        yield* fs.readDirectory(directory).pipe(Effect.map((names) => names.toSorted())),
        ["models.json", "settings.json"],
      );
      assert.equal(yield* fs.readFileString(path.join(user, "models.json")), "user configuration");
      assert.deepEqual([...first.allowedModels], ["opencodex/provider/model"]);
      assert.deepEqual(calls[0]?.args, ["export", "--client", "pi", "--json"]);
      assert.equal(calls[0]?.command, "/fixture/ocx");
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

it.effect("merges both OpenCode Home generations while keeping unrelated inline settings", () => {
  const { layer } = boundary(openCodeExport);
  return Effect.gen(function* () {
    const inherited = JSON.stringify({
      theme: "fixture-theme",
      provider: { other: { options: { baseURL: "http://127.0.0.1:9/v1" } } },
    });
    const environment = [{ name: "OPENCODE_CONFIG_CONTENT", value: inherited, sensitive: false }];
    const runtime = yield* prepare("opencode", {}, environment);
    const merged = JSON.parse(variable(runtime.environment, "OPENCODE_CONFIG_CONTENT") ?? "{}");
    assert.equal(merged.theme, "fixture-theme");
    assert.equal(merged.provider.other.options.baseURL, "http://127.0.0.1:9/v1");
    assert.equal(merged.provider.opencodex.options.baseURL, HOME);
    assert.equal(merged.provider.opencodex.options.apiKey, "opencodex-loopback");
    assert.equal(merged.providers.opencodex.settings.baseURL, HOME);
    assert.equal(environment[0]?.value, inherited);
    assert.deepEqual([...runtime.allowedModels], ["opencodex/provider/model"]);
  }).pipe(Effect.provide(layer));
});

it.effect("shadows inherited Claude credentials only in the Home process overlay", () => {
  const { calls, layer } = boundary(openCodeExport);
  return Effect.gen(function* () {
    const environment = [
      { name: "ANTHROPIC_API_KEY", value: "fixture-not-a-key", sensitive: true },
      { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", sensitive: false },
    ];
    const runtime = yield* prepare("claudeAgent", {}, environment);
    assert.equal(variable(runtime.environment, "ANTHROPIC_BASE_URL"), "http://127.0.0.1:10100");
    assert.equal(variable(runtime.environment, "ANTHROPIC_AUTH_TOKEN"), "opencodex-loopback");
    assert.equal(variable(runtime.environment, "ANTHROPIC_API_KEY"), "");
    assert.equal(variable(runtime.environment, "CLAUDE_CODE_USE_BEDROCK"), "");
    assert.equal(environment[0]?.value, "fixture-not-a-key");
    assert.deepEqual([...runtime.allowedModels], ["provider/model"]);
    assert.deepEqual(calls[0]?.args, ["export", "--client", "opencode", "--json"]);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  {
    name: "a foreign Pi endpoint",
    driver: "pi",
    stdout: {
      providers: {
        opencodex: { ...piExport.providers.opencodex, baseUrl: "http://127.0.0.1:9/v1" },
      },
    },
  },
  {
    name: "a credential header",
    driver: "opencode",
    stdout: {
      ...openCodeExport,
      providers: {
        opencodex: {
          settings: { baseURL: HOME, headers: { Authorization: "x" } },
          models: { "provider/model": {} },
        },
      },
    },
  },
  {
    name: "disagreeing OpenCode generations",
    driver: "opencode",
    stdout: {
      ...openCodeExport,
      providers: { opencodex: { settings: { baseURL: HOME }, models: {} } },
    },
  },
  {
    name: "no exported models",
    driver: "pi",
    stdout: { providers: { opencodex: { ...piExport.providers.opencodex, models: [] } } },
  },
  { name: "invalid JSON", driver: "pi", stdout: "not json" },
  {
    name: "a failed export",
    driver: "pi",
    stdout: piExport,
    output: { code: ChildProcessSpawner.ExitCode(2) },
  },
  { name: "a timed-out export", driver: "pi", stdout: piExport, output: { timedOut: true } },
  { name: "a truncated export", driver: "pi", stdout: piExport, output: { stdoutTruncated: true } },
  {
    name: "an invalid UTF-8 export",
    driver: "pi",
    stdout: piExport,
    output: { stdoutInvalidUtf8: true },
  },
] as const)("refuses $name without writing a Pi directory or returning a runtime", (row) => {
  const { calls, layer } = boundary(row.stdout, "output" in row ? { output: row.output } : {});
  return Effect.gen(function* () {
    const result = yield* prepare(row.driver, {}).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(calls.length, 1);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const server = yield* Config.ServerConfig;
    assert.isFalse(yield* fs.exists(path.join(server.stateDir, "providers", "pi")));
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  {
    name: "an external OpenCode server",
    driver: "opencode",
    config: { serverUrl: "http://127.0.0.1:4096" },
  },
  {
    name: "a Claude model override",
    driver: "claudeAgent",
    config: { launchArgs: "--model=other" },
  },
  { name: "a Pi extension", driver: "pi", config: { launchArgs: "-e ./extension.ts" } },
  {
    name: "a stopped listener",
    driver: "pi",
    config: {},
    inventory: { runtime: { ...fleetSnapshot("mac-studio").runtime, healthy: false } },
  },
  {
    name: "an unlinked OpenCodex",
    driver: "pi",
    config: {},
    inventory: { link: { ...fleetSnapshot("mac-studio").link, role: "none" as const } },
  },
  {
    name: "a different listener port",
    driver: "pi",
    config: {},
    inventory: { runtime: { ...fleetSnapshot("mac-studio").runtime, port: 10101 } },
  },
  { name: "no selected executable", driver: "pi", config: {}, inventory: { binaries: [] } },
  {
    name: "a remote address",
    driver: "pi",
    config: { opencodexBaseUrl: "https://home.example/v1" },
  },
] as const)("refuses $name before running the OpenCodex export", (row) => {
  const { calls, layer } = boundary(
    piExport,
    "inventory" in row ? { inventory: row.inventory } : {},
  );
  return Effect.gen(function* () {
    const result = yield* prepare(row.driver, row.config).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["not json", JSON.stringify({ provider: "not a map" })])(
  "refuses a malformed inherited OpenCode inline configuration instead of replacing it: %s",
  (inherited) => {
    const { layer } = boundary(openCodeExport);
    return Effect.gen(function* () {
      const environment = [{ name: "OPENCODE_CONFIG_CONTENT", value: inherited, sensitive: false }];
      const result = yield* prepare("opencode", {}, environment).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "inspects without writing and publishes a changed Pi catalog beside the active one",
  () => {
    let models = [{ id: "provider/model", name: "Home model" }];
    const { layer } = boundary(() => ({
      providers: { opencodex: { ...piExport.providers.opencodex, models } },
    }));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* Config.ServerConfig;
      const root = path.join(server.stateDir, "providers", "pi", instanceId, "home-agent");
      const inspected = yield* inspectProviderHomeRuntime(
        "pi",
        instanceId,
        { modelRoute: "opencodex", opencodexBaseUrl: HOME },
        [],
      ).pipe(Effect.provideService(HostProcess.Environment, {}));
      assert.deepEqual([...inspected.allowedModels], ["opencodex/provider/model"]);
      assert.isFalse(yield* fs.exists(root));
      const active = variable((yield* prepare("pi", {})).environment, "PI_CODING_AGENT_DIR") ?? "";
      const activeModels = yield* fs.readFileString(path.join(active, "models.json"));
      models = [{ id: "provider/other", name: "Other" }];
      const next = yield* prepare("pi", {});
      const published = variable(next.environment, "PI_CODING_AGENT_DIR") ?? "";
      assert.notEqual(published, active);
      assert.equal(yield* fs.readFileString(path.join(active, "models.json")), activeModels);
      assert.include(
        yield* fs.readFileString(path.join(published, "models.json")),
        "provider/other",
      );
      assert.deepEqual([...next.allowedModels], ["opencodex/provider/other"]);
      const leftovers = (yield* fs.readDirectory(root)).filter((name) => name.startsWith("."));
      assert.deepEqual(leftovers, []);
    }).pipe(Effect.provide(layer));
  },
);
