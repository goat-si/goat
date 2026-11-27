import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { describe, it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";

import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import {
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@goat/provider-core/server/maintenanceResolver";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const NATIVE_CLI_DRIVER = ProviderDriverKind.make("nativeCli");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const NATIVE_CLI_INSTANCE_ID = ProviderInstanceId.make("nativeCli");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");
const encoder = new TextEncoder();

// Pin Linux so raw command/args assertions bypass Windows shim resolution.
const layerNonWindowsPlatform = Layer.succeed(HostProcess.Platform, "linux");

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === NATIVE_CLI_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "native-agent",
      updateArgs: ["update"],
      updateLockKey: "native-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: "0.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseNativeCliProvider: ServerProvider = {
  ...baseProvider,
  instanceId: NATIVE_CLI_INSTANCE_ID,
  driver: NATIVE_CLI_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const layerLatestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv | undefined },
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: NodeJS.ProcessEnv | undefined };
      };
      return Effect.succeed(
        mockHandle(handler(childProcess.command, childProcess.args, childProcess.options)),
      );
    }),
  );
}
function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
  options?: {
    readonly installedVersionAfterUpdate?: string;
  },
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);
    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });
    const registry: ProviderRegistry.ProviderRegistry["Service"] = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshAfterUpdate: () => {
        const version = options?.installedVersionAfterUpdate;
        if (version === undefined) {
          return Ref.get(providersRef);
        }
        return Ref.updateAndGet(providersRef, (providers) =>
          providers.map((provider) => ({
            ...provider,
            version,
          })),
        );
      },
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      invalidateModelCaches: () => Effect.void,
      refreshModelCatalog: Effect.void,
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    return {
      registry,
      providersRef,
      updateStatesRef,
    };
  });
}

const makeTestRunner = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [CODEX_DRIVER, OPENCODE_DRIVER].map((driver) => ({
      driver,
      t3CodeRange: ">=0.0.42",
      ranges: [],
    })),
  },
  latestVersions: Layer.Layer<ProviderLatestVersions.ProviderLatestVersions> = ProviderLatestVersions.layer,
) =>
  Layer.build(
    ProviderMaintenanceRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
          Layer.succeed(ModelManifest.ModelManifest, {
            current: Effect.succeed(manifest),
            refresh: Effect.succeed(manifest),
            forceRefresh: Effect.succeed(manifest),
            refreshOnDemand: Effect.succeed(manifest),
            refreshInBackground: Effect.void,
          }),
          latestVersions,
          ProviderInstallationGate.layer,
        ),
      ),
    ),
  ).pipe(Effect.map(Context.get(ProviderMaintenanceRunner.ProviderMaintenanceRunner)));

describe("provider maintenance failure output", () => {
  it.live("runs update commands without a piped stdin", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed({
            ...lifecycleFor(provider),
            update: {
              command: "codex update",
              executable: process.execPath,
              args: [
                "-e",
                "process.exit(require('node:fs').fstatSync(0).isCharacterDevice() ? 0 : 1)",
              ],
              lockKey: "codex-native",
            },
          }),
      });
      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(
        result.providers[0]?.updateState?.message,
        "Update command completed, but GOAT still detects an outdated provider version.",
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, layerLatestVersionHttpClient("1.0.0"))),
    ),
  );
  it.effect("reports the updater's error rather than a trailing hint after it", () =>
    Effect.forEach(
      [
        {
          stdout: "Current version: 2.1.310\nChecking for updates to latest version...\n",
          stderr: [
            "Error: Failed to install native update",
            "TelemetrySafeError: Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): Request failed with status code 403",
            'Try running "claude doctor" for diagnostics',
            "",
          ].join("\n"),
          reason: "Request failed with status code 403",
          hint: "claude doctor",
        },
        {
          stdout: "",
          stderr: [
            "Failed to check for updates",
            "Unable to fetch latest version from npm registry",
            "",
            "Possible causes:",
            "  • Network connectivity issues",
            "  • npm registry is unreachable",
            "  • Corporate proxy/firewall blocking npm",
            "",
            "Try:",
            "  • Check your internet connection",
            "  • Run with --debug flag for more details",
            "  • Manually check: npm view @anthropic-ai/claude-code version",
            "  • Check if you need to login: npm whoami",
            "",
          ].join("\n"),
          reason: "Failed to check for updates",
          hint: "npm whoami",
        },
      ],
      ({ stdout, stderr, reason, hint }) =>
        Effect.gen(function* () {
          const { registry } = yield* makeRegistry(baseNativeCliProvider);
          const updater = yield* makeTestRunner(registry);

          const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
          const message = result.providers[0]?.updateState?.message ?? "";

          assert.include(message, reason);
          assert.notInclude(message, hint);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerNonWindowsPlatform,
              layerLatestVersionHttpClient("0.0.0"),
              layerMockSpawner(() => ({ stdout, stderr, code: 1 })),
            ),
          ),
        ),
      { discard: true },
    ),
  );
  it.effect("an update stopped by server shutdown ends failed instead of running forever", () => {
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const serverScope = yield* Scope.make();
      const updater = yield* makeTestRunner(registry).pipe(Scope.provide(serverScope));
      yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Scope.close(serverScope, Exit.void);
      const last = (yield* Ref.get(updateStatesRef)).at(-1);
      assert.deepStrictEqual(
        [last?.status, last?.message],
        ["failed", "Update stopped before it finished."],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({
            exitCode: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })),
        ),
      ),
    );
  });

  it.effect("a shutdown while the final state is written still records it", () => {
    const writing = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const serverScope = yield* Scope.make();
      const updater = yield* makeTestRunner({
        ...registry,
        setProviderMaintenanceActionState: (input) =>
          input.state?.status === "succeeded"
            ? Deferred.succeed(writing, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(registry.setProviderMaintenanceActionState(input)),
              )
            : registry.setProviderMaintenanceActionState(input),
      }).pipe(Scope.provide(serverScope));

      yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
      yield* Deferred.await(writing);
      const shutdown = yield* Scope.close(serverScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(shutdown);

      assert.strictEqual((yield* Ref.get(updateStatesRef)).at(-1)?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });

  it.effect("finishes a queued update whose caller is interrupted", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider, {
        installedVersionAfterUpdate: "1.0.0",
      });
      const firstFinished = yield* Deferred.make<void>();
      let blockQueuedState = true;
      const queuedStateWrittenLatch: { resolve: () => void } = { resolve: () => {} };
      const releaseQueuedStateLatch: { resolve: () => void } = { resolve: () => {} };
      const queuedStateWritten = new Promise<void>((resolve) => {
        queuedStateWrittenLatch.resolve = resolve;
      });
      const releaseQueuedState = new Promise<void>((resolve) => {
        releaseQueuedStateLatch.resolve = resolve;
      });

      const updater = yield* makeTestRunner({
        ...registry,
        setProviderMaintenanceActionState: Effect.fn(
          "providerMaintenanceRunner.test.blockQueuedState",
        )(function* (input) {
          const providers = yield* registry.setProviderMaintenanceActionState(input);
          if (input.state?.status === "queued" && blockQueuedState) {
            queuedStateWrittenLatch.resolve();
            yield* Effect.promise(() => releaseQueuedState);
          }
          if (input.state?.status === "succeeded") {
            yield* Deferred.succeed(firstFinished, undefined);
          }
          return providers;
        }),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => queuedStateWritten);
      blockQueuedState = false;

      yield* Fiber.interrupt(first);
      releaseQueuedStateLatch.resolve();
      yield* Deferred.await(firstFinished);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    ),
  );

  it.effect(
    "keeps the update command running and records its result when the caller is interrupted",
    () =>
      Effect.gen(function* () {
        const kills: Array<string> = [];
        const spawned = yield* Deferred.make<void>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const finished = yield* Deferred.make<ServerProviderUpdateState>();
        const spawner = ChildProcessSpawner.make(() =>
          Deferred.succeed(spawned, undefined).pipe(
            Effect.as(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Deferred.await(exit),
                isRunning: Effect.succeed(true),
                kill: () => Effect.sync(() => kills.push("kill")),
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.make(encoder.encode("added 1 package")),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const { registry } = yield* makeRegistry(baseOpenCodeProvider);
          const updater = yield* makeTestRunner({
            ...registry,
            setProviderMaintenanceActionState: Effect.fn(
              "providerMaintenanceRunner.test.recordFinishedState",
            )(function* (input) {
              const providers = yield* registry.setProviderMaintenanceActionState(input);
              const status = input.state?.status;
              if (input.state && status !== "queued" && status !== "running") {
                yield* Deferred.succeed(finished, input.state);
              }
              return providers;
            }),
          });

          const caller = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkChild);
          yield* Deferred.await(spawned);
          yield* Fiber.interrupt(caller);

          assert.deepStrictEqual(
            kills,
            [],
            "interrupting the updateProvider caller killed the running npm install",
          );

          yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          const finalState = yield* Deferred.await(finished);
          assert.strictEqual(finalState.status, "succeeded");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerNonWindowsPlatform,
              layerLatestVersionHttpClient("0.0.0"),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        );
      }),
  );
});
