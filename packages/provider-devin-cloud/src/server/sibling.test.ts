import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2ProviderRef,
  type ServerSettings,
} from "@goat/contracts";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Cli from "./cli.ts";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

const id = ProviderInstanceId.make("devin-sibling");
const hostFor = (settings: ServerSettings) =>
  ProviderHost.ProviderHost.of({
    paths: {
      cwd: "/project",
      baseDir: "/sandbox",
      stateDir: "/sandbox/userdata",
      providerStatusCacheDir: "/sandbox/cache",
      attachmentsDir: "/sandbox/attachments",
    },
    settings: {
      get: Effect.succeed(settings),
      withSnapshot: (use) => use(settings),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(false),
    resolveAttachmentPath: () => null,
    credentials: () => Effect.die("CLI credentials must not be inspected or copied"),
  });
const settingsFor = (config: Record<string, unknown>, driver = "acpRegistry"): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [id]: {
      driver: ProviderDriverKind.make(driver),
      environment: [
        { name: "HOME", value: "/sibling-home", sensitive: false },
        { name: "PATH", value: "/sibling-bin", sensitive: false },
      ],
      config,
    },
  },
});
const catalogFor = (
  inspect: AcpRegistrySupport.AcpRegistryCatalog["Service"]["inspect"],
  resolve: AcpRegistrySupport.AcpRegistryCatalog["Service"]["resolve"],
) =>
  AcpRegistrySupport.AcpRegistryCatalog.of({
    search: () => Effect.die("No registry search"),
    prepare: () => Effect.die("No install"),
    uninstallManagedBinary: () => Effect.die("No uninstall"),
    inspect,
    resolve,
  });
const noSpawn = lazyChildProcessSpawner(() => Effect.die("Sibling selection must not spawn"));

it.effect("inspects before resolve and inherits only the selected executable and profile env", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const source of ["registry", "local"] as const) {
        const settings = settingsFor({
          source,
          agentId: "devin",
          commandPath: "/chosen/devin",
          commandArgs: ["acp", "--local-only-option"],
        });
        const steps: string[] = [];
        const catalog = catalogFor(
          (selected, env) =>
            Effect.sync(() => {
              steps.push("inspect");
              assert.equal(selected.source, source);
              assert.equal(env?.HOME, "/sibling-home");
              assert.equal(env?.PATH, "/sibling-bin");
              return {
                status: "ready" as const,
                agentId: "devin",
                version: null,
                distribution: "local" as const,
              };
            }),
          (selected, cwd, env) =>
            Effect.sync(() => {
              steps.push("resolve");
              assert.deepEqual(steps, ["inspect", "resolve"]);
              assert.equal(selected.commandPath, "/chosen/devin");
              assert.equal(env?.HOME, "/sibling-home");
              assert.equal(cwd, "/project");
              return {
                distribution: "local" as const,
                spawn: {
                  command: "/resolved/selected/devin",
                  args: ["acp", "--local-only-option"],
                  cwd,
                  env: { ...env, XDG_DATA_HOME: "/sibling-data" },
                  shell: false,
                },
              };
            }),
        );
        const cli = yield* Cli.DevinCloudCli.pipe(
          Effect.provide(Cli.layer),
          Effect.provideService(ProviderHost.ProviderHost, hostFor(settings)),
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );
        const selected = yield* cli.resolve(id, "/project");
        assert.equal(selected.command, "/resolved/selected/devin");
        assert.equal(selected.env.HOME, "/sibling-home");
        assert.equal(selected.env.XDG_DATA_HOME, "/sibling-data");
        assert.notInclude(Object.keys(selected), "args");
        const refCodec = Schema.fromJsonString(OrchestrationV2ProviderRef);
        const persistedRef = yield* Schema.encodeEffect(refCodec)({
          driver: ProviderDriverKind.make("devinCloud"),
          nativeId: "devin-saved",
          strength: "strong",
          fingerprint: selected.binding,
          ordinal: 0,
        });
        const restoredRef = yield* Schema.decodeEffect(refCodec)(persistedRef);
        assert.equal(restoredRef.fingerprint, selected.binding);
        const missing = yield* Effect.result(cli.resolve("missing-sibling", "/project"));
        assert.isTrue(Result.isFailure(missing));
        assert.deepEqual(steps, ["inspect", "resolve"]);
      }
    }),
  ),
);

it.effect("auto-selects one enabled Devin ACP sibling and fingerprints its resolved id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sibling = settingsFor({ agentId: "devin", commandPath: "/chosen/devin" });
      const catalog = catalogFor(
        () =>
          Effect.succeed({
            status: "ready" as const,
            agentId: "devin",
            version: null,
            distribution: "local" as const,
          }),
        (_settings, cwd, env) =>
          Effect.succeed({
            distribution: "local" as const,
            spawn: { command: "/resolved/devin", args: [], cwd, env: env ?? {}, shell: false },
          }),
      );
      const makeCli = (settings: ServerSettings) =>
        Cli.DevinCloudCli.pipe(
          Effect.provide(Cli.layer),
          Effect.provideService(ProviderHost.ProviderHost, hostFor(settings)),
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );
      const missing = yield* makeCli({ ...sibling, providerInstances: {} });
      const noMatch = yield* Effect.result(missing.resolve("", "/project"));
      assert.isTrue(Result.isFailure(noMatch));
      if (Result.isFailure(noMatch)) assert.equal(noMatch.failure.reason, "missing");
      const one = yield* makeCli(sibling);
      const selected = yield* one.resolve("", "/project");
      const explicit = yield* one.resolve(id, "/project");
      assert.equal(selected.sourceInstanceId, id);
      assert.equal(selected.binding, explicit.binding);
      assert.equal(JSON.parse(selected.binding)[0], id);
      const many = yield* makeCli({
        ...sibling,
        providerInstances: {
          ...sibling.providerInstances,
          [ProviderInstanceId.make("second-devin")]: {
            driver: ProviderDriverKind.make("acpRegistry"),
            config: { agentId: "devin", commandPath: "/another/devin" },
          },
        },
      });
      const ambiguous = yield* Effect.result(many.resolve("", "/project"));
      assert.isTrue(Result.isFailure(ambiguous));
      if (Result.isFailure(ambiguous)) {
        assert.equal(ambiguous.failure.reason, "ambiguous");
        assert.include(ambiguous.failure.message, "Choose a Devin ACP instance");
      }
      const disabled = yield* makeCli({
        ...sibling,
        providerInstances: {
          ...sibling.providerInstances,
          [ProviderInstanceId.make("second-devin")]: {
            driver: ProviderDriverKind.make("acpRegistry"),
            enabled: false,
            config: { agentId: "devin" },
          },
        },
      });
      assert.equal((yield* disabled.resolve("", "/project")).sourceInstanceId, id);
    }),
  ),
);

it.effect("rejects unprepared and unavailable installs without resolving or installing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inspections: AcpRegistrySupport.AcpRegistryInspection[] = [
        { status: "unprepared", agentId: "devin", version: "3000.11.3", distribution: "binary" },
        { status: "missing_runner", version: null, distribution: "local" },
        { status: "not_found", agentId: "devin" },
        { status: "ready", agentId: "devin", version: "3000.11.3", distribution: "npx" },
      ];
      for (const inspection of inspections) {
        const cli = yield* Cli.DevinCloudCli.pipe(
          Effect.provide(Cli.layer),
          Effect.provideService(
            ProviderHost.ProviderHost,
            hostFor(settingsFor({ agentId: "devin" })),
          ),
          Effect.provideService(
            AcpRegistrySupport.AcpRegistryCatalog,
            catalogFor(
              () => Effect.succeed(inspection),
              () => Effect.die("Not installed; do not resolve"),
            ),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        );
        const result = yield* Effect.result(cli.resolve(id, "/project"));
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.equal(result.failure.stage, "resolve");
      }
    }),
  ),
);

it.effect(
  "rejects another provider, disabled sibling and local shell wrapper before catalog access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cases = [
          settingsFor({ agentId: "devin" }, "other"),
          settingsFor({ agentId: "other" }),
          settingsFor({ agentId: "devin", enabled: false }),
          settingsFor({ source: "local", commandPath: "/bin/sh", commandArgs: ["devin"] }),
        ];
        for (const settings of cases) {
          const cli = yield* Cli.DevinCloudCli.pipe(
            Effect.provide(Cli.layer),
            Effect.provideService(ProviderHost.ProviderHost, hostFor(settings)),
            Effect.provideService(
              AcpRegistrySupport.AcpRegistryCatalog,
              catalogFor(
                () => Effect.die("Invalid sibling; do not inspect"),
                () => Effect.die("Invalid sibling; do not resolve"),
              ),
            ),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
          );
          const result = yield* Effect.result(cli.resolve(id, "/project"));
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.equal(result.failure.stage, "sibling");
        }
      }),
    ),
);

it.effect("readiness probes the selected command/profile without shell or ACP creation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands: ReadonlyArray<string>[] = [];
      const launch: Cli.DevinCloudLaunch = {
        sourceInstanceId: id,
        command: "/chosen/devin",
        cwd: "/project",
        env: { HOME: "/sibling-home" },
        binding: "fixture",
      };
      const stdout = [
        "devin 3000.11.3 (fixture)",
        "--cloud Relay",
        "Logged in (via Devin).\nSynthetic account: example@acme.example",
      ];
      const spawner = lazyChildProcessSpawner((command) =>
        Effect.sync(() => {
          assert.equal(command._tag, "StandardCommand");
          if (command._tag === "StandardCommand") {
            commands.push(command.args);
            assert.equal(command.command, launch.command);
            assert.equal(command.options.cwd, launch.cwd);
            assert.equal(command.options.env?.HOME, "/sibling-home");
            assert.equal(command.options.shell, false);
            assert.equal(command.options.stdin, "ignore");
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(stdout[commands.length - 1]!)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      );
      const cli = yield* Cli.DevinCloudCli.pipe(
        Effect.provide(Cli.layer),
        Effect.provideService(ProviderHost.ProviderHost, hostFor(DEFAULT_SERVER_SETTINGS)),
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogFor(
            () => Effect.die("Probe does not inspect"),
            () => Effect.die("Probe does not resolve"),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(yield* cli.probe(launch), "3000.11.3");
      assert.deepEqual(commands, [["--version"], ["acp", "--help"], ["auth", "status"]]);
    }),
  ),
);
