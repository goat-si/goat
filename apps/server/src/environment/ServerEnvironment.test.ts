import { vi } from "vite-plus/test";
import { ProviderMemoryImportRuntime } from "../memory/imports/MemoryImportTypes.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MemoryOperationId,
  MemorySpaceId,
  ORCHESTRATION_PROTOCOL_VERSION,
  supportsMemoryProtocol,
} from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { DEFAULT_SIGNAL_EXPORT } from "@goat/shared/observability";
import * as HostProcess from "@goat/shared/HostProcess";
import * as OtelEnvironment from "@goat/shared/otelEnvironment";

import * as RuntimeIdentity from "../runtimeIdentity.ts";
import { makePersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { ownRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Hub from "../memory/MemoryHubHttp.ts";
import * as HubAuth from "../memory/MemoryHubAuth.ts";
import * as Store from "../memory/MemoryStore.ts";
import * as HttpRouter from "effect/http/HttpRouter";
import * as ServerEnvironment from "./ServerEnvironment.ts";

const layerServerEnvironment = (baseDir: string) =>
  ServerEnvironment.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const layerEmptySecretStore = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
    remove: () => Effect.void,
  }),
);

const makeServerConfig = Effect.fn(function* (baseDir: string) {
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

  return {
    ...derivedPaths,
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    cwd: process.cwd(),
    baseDir,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: false,
    startupPresentation: "browser",
  } satisfies ServerConfig.ServerConfig["Service"];
});

it.layer(NodeServices.layer)("ServerEnvironmentLive", (it) => {
  it.effect(
    "shares one start identity between descriptor and runtime state, and changes it on restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped();
        const observe = Effect.gen(function* () {
          const environment = yield* ServerEnvironment.ServerEnvironment;
          const identity = yield* RuntimeIdentity.RuntimeIdentity;
          const descriptor = yield* environment.getDescriptor;
          const state = yield* makePersistedServerRuntimeState({
            config: { host: undefined, devUrl: undefined },
            port: 13773,
            instanceId: identity.instanceId,
          });
          expect(descriptor.instanceId).toBe(identity.instanceId);
          expect(state.instanceId).toBe(descriptor.instanceId);
          expect(descriptor.protocol).toEqual(
            ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION),
          );
          expect(descriptor.capabilities.drainRestart).toBe(true);
          expect(descriptor.capabilities.memoryHubProtocolVersion).toBeUndefined();
          return identity.instanceId;
        }).pipe(Effect.provide(Layer.fresh(layerServerEnvironment(baseDir))));
        expect(yield* observe).not.toBe(yield* observe);
      }),
  );
  it.effect("advertises core memory without provider import in web and desktop modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const config = yield* makeServerConfig(baseDir);
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      for (const mode of ["web", "desktop"] as const) {
        const descriptor = yield* ServerEnvironment.ServerEnvironment.use(
          (environment) => environment.getDescriptor,
        ).pipe(
          Effect.provide(
            ServerEnvironment.layer.pipe(
              Layer.provide(layerEmptySecretStore),
              Layer.provide(ServerConfig.layer({ ...config, mode })),
            ),
          ),
        );
        expect(descriptor.capabilities.memory?.protocolVersion).toBe(1);
        expect(descriptor.capabilities.memory?.refusedReverts).toBe(true);
        expect(descriptor.capabilities.memory?.hubDiagnostics).toBe(true);
        expect(supportsMemoryProtocol(descriptor.capabilities)).toBe(true);
        expect(descriptor.capabilities.memory?.importProvider).toBeUndefined();
        expect(descriptor.capabilities.memory?.importTurnStartFit).toBeUndefined();
        expect(descriptor.capabilities.memory?.importProvider === true).toBe(false);
        expect(descriptor.capabilities.memory?.hub).toBeUndefined();
        expect(descriptor.capabilities.memoryHubProtocolVersion).toBeUndefined();
      }
    }),
  );
  it.effect("advertises provider import only when the acquired runtime is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const descriptor = yield* ServerEnvironment.ServerEnvironment.use(
        (s) => s.getDescriptor,
      ).pipe(
        Effect.provide(
          layerServerEnvironment(baseDir).pipe(
            Layer.provide(
              Layer.succeed(ProviderMemoryImportRuntime, {
                run: () => Effect.die("descriptor must not invoke provider import"),
              }),
            ),
          ),
        ),
      );
      expect(descriptor.capabilities.memory).toEqual({
        protocolVersion: 1,
        importProvider: true,
        importTurnStartFit: true,
        refusedReverts: true,
        resolutionInputs: true,
        retainedLocalSpace: true,
        generationHold: true,
        hubDiagnostics: true,
      });
      expect(descriptor.capabilities.memoryHubProtocolVersion).toBeUndefined();
    }),
  );
  it.effect("advertises the Slack channel in the assembled server descriptor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-slack-channel-" });
      const descriptor = yield* ServerEnvironment.ServerEnvironment.use(
        (environment) => environment.getDescriptor,
      ).pipe(Effect.provide(layerServerEnvironment(baseDir)));
      expect(descriptor.capabilities.slackChannel).toBe(true);
      expect(descriptor.capabilities.goatBotHome).toBe(true);
      expect(descriptor.capabilities.goatBotStatus).toBe(true);
    }),
  );
  // The fixture is a POSIX npm prefix on the real filesystem, which a Windows host cannot
  // produce, and win32 never claims npm-global ownership. Windows coverage: #1125.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes proven install ownership only for manually updated servers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped();
        const prefix = `${baseDir}/node`;
        const entry = `${prefix}/lib/node_modules/t3/dist/bin.mjs`;
        yield* fs.makeDirectory(`${prefix}/lib/node_modules/t3/dist`, { recursive: true });
        yield* fs.makeDirectory(`${prefix}/bin`, { recursive: true });
        yield* fs.writeFileString(entry, "");
        yield* fs.writeFileString(
          `${prefix}/lib/node_modules/t3/package.json`,
          '{"name":"t3","version":"0.0.45","bin":{"t3":"./dist/bin.mjs"}}',
        );
        yield* fs.symlink(entry, `${prefix}/bin/t3`);
        const config = yield* makeServerConfig(baseDir);
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        for (const mode of ["web", "desktop"] as const) {
          const descriptor = yield* Effect.gen(function* () {
            const environment = yield* ServerEnvironment.ServerEnvironment;
            return yield* environment.getDescriptor;
          }).pipe(
            Effect.provide(
              ServerEnvironment.layer.pipe(
                Layer.provide(layerEmptySecretStore),
                Layer.provide(ServerConfig.layer({ ...config, mode })),
              ),
            ),
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, {}),
          );
          expect(descriptor.capabilities.serverInstallation).toEqual(
            mode === "web" ? { kind: "npm-global", prefix: yield* fs.realPath(prefix) } : undefined,
          );
          expect(descriptor.capabilities.serverSelfUpdate).toBe(
            mode === "web" ? undefined : "desktop-managed",
          );
          expect(descriptor.capabilities).toMatchObject({
            settledWorktreeCleanup: true,
            storageCleanupRun: true,
            projectWorktreeCleanup: true,
            worktreesDirectory: true,
            threadAutoSettlementScope: true,
          });
        }
      }),
  );
  it.effect.each([
    { name: "missing", content: undefined },
    { name: "empty", content: "" },
    { name: "whitespace-only", content: " \t\n" },
  ])("concurrent initializers recover a $name environment id file", ({ content }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-server-environment-concurrent-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      yield* fileSystem.makeDirectory(serverConfig.stateDir, { recursive: true });
      if (content !== undefined) {
        yield* fileSystem.writeFileString(serverConfig.environmentIdPath, content);
      }
      const bothGenerated = yield* Deferred.make<void>();
      const bothReadEmpty = yield* Deferred.make<void>();
      const firstInitialized = yield* Deferred.make<void>();
      let remaining = 2;
      let emptyReads = 0;
      const readIdentity = Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        return yield* identity.getEnvironmentId;
      }).pipe(
        Effect.tap(() => Deferred.succeed(firstInitialized, undefined)),
        Effect.provide(Layer.fresh(ServerEnvironment.layerIdentity)),
        Effect.provideService(ServerConfig.ServerConfig, serverConfig),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          readFileString: (path) =>
            fileSystem.readFileString(path).pipe(
              Effect.tap(
                Effect.fn(function* (value) {
                  if (path !== serverConfig.environmentIdPath || remaining > 0 || value.trim()) {
                    return;
                  }
                  if (++emptyReads === 2) {
                    yield* Deferred.succeed(bothReadEmpty, undefined);
                    yield* Deferred.await(firstInitialized);
                  } else {
                    yield* Deferred.await(bothReadEmpty);
                  }
                }),
              ),
            ),
        }),
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          randomUUIDv4: (() =>
            Effect.gen(function* () {
              const id = yield* crypto.randomUUIDv4();
              if (--remaining === 0) {
                yield* Deferred.succeed(bothGenerated, undefined);
              }
              yield* Deferred.await(bothGenerated);
              return id;
            })) as Crypto.Crypto["randomUUIDv4"],
        }),
      );

      const [first, second] = yield* Effect.all([readIdentity, readIdentity], {
        concurrency: "unbounded",
      });
      const persisted = yield* fileSystem.readFileString(serverConfig.environmentIdPath);

      expect(first).toBe(second);
      expect(persisted.trim()).toBe(first);
    }),
  );

  it.effect("persists the environment id across service restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(layerServerEnvironment(baseDir)));
      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(layerServerEnvironment(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(first.orchestrationProtocolVersion).toBe(ORCHESTRATION_PROTOCOL_VERSION);
      expect(first.sshRuntimeProtocolVersion).toBe(SSH_RUNTIME_PROTOCOL_VERSION);
      expect(second.capabilities.repositoryIdentity).toBe(true);
      expect(second.capabilities.connectionProbe).toBe(true);
      expect(second.capabilities.attachmentUploads).toBe(true);
      expect(second.capabilities.fileAttachments).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
      expect(second.capabilities.pullRequests).toBe(true);
      expect(second.capabilities.requiredWorktreeBootstrap).toBe(true);
      expect(second.capabilities.usagePriceOverrides).toBe(true);
      expect(second.capabilities.threadActiveReorder).toBe(true);
      expect(second.capabilities.threadTitleRegeneration).toBe(true);
      expect(second.capabilities.threadPullRequests).toBe(true);
      expect(second.capabilities.threadPullRequestLinking).toBe(true);
      expect(second.capabilities.serverResolvedCommandContext).toBe(true);
      expect(second.capabilities.projectProviderInstanceOverrides).toBe(true);
      expect(second.capabilities.automaticServerUpdates).toBe(true);
      expect(second.capabilities.agentActivityPublishing).toBe(false);
    }),
  );

  it.effect("reports agent activity publishing from the current secret state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-server-environment-publish-test-",
      });
      const layerTest = Layer.mergeAll(
        ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer)),
        ServerSecretStore.layer,
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        const encode = (value: string) => new TextEncoder().encode(value);

        const unlinked = yield* serverEnvironment.getDescriptor;
        expect(unlinked.capabilities.agentActivityPublishing).toBe(false);

        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("true"));
        const withoutLink = yield* serverEnvironment.getDescriptor;
        expect(withoutLink.capabilities.agentActivityPublishing).toBe(false);

        yield* secrets.set(RELAY_URL_SECRET, encode(""));
        yield* secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential"));
        const emptyUrl = yield* serverEnvironment.getDescriptor;
        expect(emptyUrl.capabilities.agentActivityPublishing).toBe(false);

        yield* secrets.set(RELAY_URL_SECRET, encode("https://relay.example"));
        const linked = yield* serverEnvironment.getDescriptor;
        expect(linked.capabilities.agentActivityPublishing).toBe(true);

        yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("false"));
        const disabled = yield* serverEnvironment.getDescriptor;
        expect(disabled.capabilities.agentActivityPublishing).toBe(false);
      }).pipe(Effect.provide(layerTest));
    }),
  );
});

it.effect("hub advertisement follows registered routes and live disable/re-enable settings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const dependencies = Settings.layer.pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    );
    const space = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
    const update = (mode: "disabled" | "hub", memorySpaceId: typeof space | null = space) =>
      Settings.MemoryHubSettingsTransitions.use((transitions) =>
        Settings.ServerSettingsService.use((settings) => settings.getSettings).pipe(
          Effect.flatMap((current) =>
            transitions.applyMemoryHubTransition(
              {
                requestId: MemoryOperationId.make(
                  `00000000-0000-4000-8000-${String(current.memoryHubVersion + 1).padStart(12, "0")}`,
                ),
                expectedVersion: current.memoryHubVersion,
                settings: mode === "disabled" ? { mode } : { mode, memorySpaceId },
              },
              Effect.void,
            ),
          ),
        ),
      );
    // Only L2 domain calls are replaced. Auth, SQLite, settings and route registration are real.
    const unused = () => Effect.die("descriptor fixture must not invoke a hub route");
    const boundary = Layer.succeed(
      Hub.MemoryHubService,
      Hub.MemoryHubService.of({
        join: unused,
        push: unused,
        pull: unused,
        claim: unused,
        renew: unused,
        applyResolution: unused,
        release: unused,
        requestSourceRead: unused,
        collectSourceReads: unused,
        respondSourceRead: unused,
        resultSourceRead: unused,
      }),
    );
    yield* Effect.gen(function* () {
      yield* update("hub");
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const descriptor = yield* environment.getDescriptor;
      expect(supportsMemoryProtocol(descriptor.capabilities)).toBe(true);
      expect(descriptor.capabilities.memory?.importProvider === true).toBe(false);
      expect(descriptor.capabilities.memory?.hub).toBeUndefined();
      expect(descriptor.capabilities.memoryHubProtocolVersion).toBeUndefined();
    }).pipe(Effect.provide(ServerEnvironment.layer.pipe(Layer.provideMerge(dependencies))));
    const auth = HubAuth.layer.pipe(Layer.provide(Store.layer));
    const routes = Hub.layer.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(boundary, auth).pipe(Layer.provideMerge(dependencies)),
      ),
      Layer.provideMerge(boundary),
      Layer.provideMerge(auth),
      Layer.provideMerge(dependencies),
      Layer.provide(HttpRouter.layer),
    );
    yield* Effect.gen(function* () {
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const expectCapabilities = Effect.fn(function* (hubVersion: 1 | undefined) {
        const descriptor = yield* environment.getDescriptor;
        expect(supportsMemoryProtocol(descriptor.capabilities)).toBe(true);
        expect(descriptor.capabilities.memory?.importProvider === true).toBe(false);
        expect(descriptor.capabilities.memory?.hub).toBeUndefined();
        expect(descriptor.capabilities.memoryHubProtocolVersion).toBe(hubVersion);
      });
      yield* update("disabled");
      yield* expectCapabilities(undefined);
      yield* update("hub", null);
      yield* expectCapabilities(undefined);
      yield* update("hub");
      yield* expectCapabilities(1);
      yield* update("disabled");
      yield* expectCapabilities(undefined);
      yield* update("hub");
      yield* expectCapabilities(1);
    }).pipe(Effect.provide(ServerEnvironment.layer.pipe(Layer.provideMerge(routes))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
