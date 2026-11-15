import { settingsSecretLiteral, type ServerProviderModel } from "@goat/contracts";
import { ProviderDriverKind } from "@goat/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCode2TextGeneration from "./v2/textGeneration.ts";
import { makeOpenCodeTextGeneration } from "./textGeneration.ts";
import { selectOpenCodeRuntimeTextGeneration } from "./runtimeTextGeneration.ts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import { AgentScope } from "@goat/shared/AgentScope";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import { compareSemverVersions } from "@goat/shared/semver";
import * as OpenCodeAdapterV2 from "./adapter.ts";
import * as OpenCode2AdapterV2 from "./v2/adapter.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import { openCodeUsageReader, type OpenCodeUsageReaderEnv } from "./usage.ts";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
import { withGoatUsageScopes } from "./usageWindowScopes.ts";
import { loadOpenCode2Catalog, loadOpenCode2DirectoryCatalog } from "./openCode2Catalog.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2GlobalSkills,
  loadOpenCode2Workspace,
  makeOpenCode2ModelLoader,
  makePendingOpenCodeProvider,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2ProviderModels,
  openCode2SkillsToServerProviderSkills,
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
  openCodeProviderModels,
  readSettledOpenCode2Catalog,
} from "./status.ts";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  LaunchEnvironment,
  currentLaunchEnvironment,
  makeCurrentLaunchEnvironment,
} from "./launchEnvironment.ts";
import { hostEnvironmentHash } from "./hostEnvironmentHash.ts";
import {
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
  probeOpenCodeBinary,
  type ProbedOpenCode,
} from "./versionProbe.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import * as OpenCode2Client from "./v2/OpenCode2Client.ts";
import * as OpenCode2Server from "./v2/OpenCode2Server.ts";
import { replaceOutdatedService } from "./v2/OpenCode2Service.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@goat/provider-core/server/driver";
import { withInstanceIdentity } from "@goat/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import {
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
} from "@goat/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@goat/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@goat/provider-core/server/snapshotSettings";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");

// A loopback server runs on this environment, but can outlive its CLI installation.
// Its reported version may therefore differ from the installed executable after an update.
export function isLocalOpenCodeServerUrl(serverUrl: string): boolean {
  const url = URL.parse(serverUrl.trim());
  if (url?.protocol !== "http:" && url?.protocol !== "https:") return false;
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)
  );
}

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

function openCodeNativeHome(commandPath: string): string | null {
  const slashed = commandPath.replaceAll("\\", "/");
  const match = /\/\.opencode\/bin\/opencode(?:\.exe)?$/i.exec(slashed);
  if (!match) return null;
  return match.index === 0 ? "/" : slashed.slice(0, match.index);
}

/** Update only within the installed package generation; 2.x converts the shared database in place. */
export const openCodeUpdateFor = (generation: ProbedOpenCode["generation"]) =>
  makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: generation === "v2" ? "@opencode/cli" : "opencode-ai",
    nativeUpdate: {
      // `isOpenCodeNativeCommandPath` is the curl installer's own binary. Name the
      // method so OpenCode does not have to infer it from `process.execPath`, which
      // fails when the binary is launched through a wrapper or shim.
      args: ["upgrade", "--method", "curl"],
      isCommandPath: isOpenCodeNativeCommandPath,
      requiresCommandPath: true,
      // The curl installer writes to `$HOME/.opencode/bin`, so point HOME at the install it replaces.
      env: (context) => {
        const home =
          openCodeNativeHome(context.realCommandPath) ??
          openCodeNativeHome(context.resolvedCommandPath);
        return home ? { HOME: home } : {};
      },
    },
  });

type OpenCodeRuntimeProbe = Effect.Success<
  ReturnType<typeof makeOpenCodeRuntimeProbe<OpenCodeRuntime.OpenCodeRuntimeError>>
>;

function byOpenCodeRuntime<A, E, R, PE>(
  probed: Effect.Effect<ProbedOpenCode | undefined, PE>,
  paths: { readonly v1: Effect.Effect<A, E, R>; readonly v2: Effect.Effect<A, E, R> },
): Effect.Effect<A, E, R> {
  return probed.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((result) => (result?.generation === "v2" ? paths.v2 : paths.v1)),
  );
}

// An unread catalog keeps what the registry found before rather than the machine catalog.
function workspaceModelsFor(
  machineModels: ReadonlyArray<ServerProviderModel>,
  cwdModels: Option.Option<ReadonlyArray<ServerProviderModel>>,
) {
  if (Option.isNone(cwdModels)) return { workspaceModelsPending: true };
  return Equal.equals(cwdModels.value, machineModels)
    ? {}
    : { models: cwdModels.value, workspaceModels: cwdModels.value };
}

// Hot reads use the last successful probe; session opens await it to select the correct protocol.
function selectOpenCodeRuntimeAdapter(input: {
  readonly probe: OpenCodeRuntimeProbe;
  readonly resolve: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>;
  readonly currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>;
  readonly v1: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly v2: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly sessionConfigKey: string;
  /** The version of the server already running for the current launch, if one is. */
  readonly runningVersion: Effect.Effect<string | undefined>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  // What a new session would launch: the server already running for the current launch answers
  // first, since a shim's probe can miss its version and a late probe for an earlier launch can
  // evict the current one from the probe cache; otherwise the probe decides.
  const current = Effect.gen(function* () {
    const probed = Option.getOrUndefined(yield* input.probe.lastSuccess);
    const running = probed?.generation === "v1" ? undefined : yield* input.runningVersion;
    const v2 = running !== undefined || probed?.generation === "v2";
    const version = running ?? (probed?.generation === "v2" ? probed.version : undefined);
    return { adapter: v2 ? input.v2 : input.v1, version };
  });
  return {
    instanceId: input.v1.instanceId,
    driver: DRIVER_KIND,
    sessionConfigKey: input.sessionConfigKey,
    getCapabilities: Effect.fn("OpenCodeDriver.getCapabilities")(function* () {
      const { adapter, version } = yield* current;
      const capabilities = yield* adapter.getCapabilities();
      return {
        ...capabilities,
        turns: {
          ...capabilities.turns,
          supportsNativeGoals:
            version !== undefined && compareSemverVersions(version, "2.2.5") >= 0,
        },
      };
    }),
    planSelectionTransition: (transition) =>
      Effect.flatMap(current, ({ adapter }) => adapter.planSelectionTransition(transition)),
    openSession: (session) =>
      input.currentEnvironment.pipe(
        Effect.flatMap((environment) =>
          input.resolve.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: DRIVER_KIND,
                  providerSessionId: session.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((result) =>
              (result.generation === "v2" ? input.v2 : input.v1).openSession(session),
            ),
            Effect.provideService(LaunchEnvironment, environment),
          ),
        ),
      ),
  };
}

export type OpenCodeDriverEnv =
  | OpenCodeAdapterV2.OpenCodeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | OpenCodeRuntime.OpenCodeRuntime
  | Path.Path;

export const OpenCodeDriver: ProviderDriver<
  OpenCodeSettings,
  OpenCodeDriverEnv,
  OpenCodeUsageReaderEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  usage: openCodeUsageReader,
  create: Effect.fn("OpencodeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
    const agentScope = yield* AgentScope;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const crypto = yield* Crypto.Crypto;
    const host = yield* ProviderHost.ProviderHost;
    const hostEnvironment = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const currentEnvironment = currentLaunchEnvironment(
      Effect.suspend(() => mergeProviderInstanceEnvironment(environment, hostEnvironment)).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.map((env) => ({ ...env })),
      ),
    );
    const processEnv = yield* currentEnvironment;
    const probeEnvironment = currentEnvironment.pipe(Effect.map(providerProbeEnvironment));
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = {
      ...config,
      enabled,
      serverPassword: settingsSecretLiteral(config.serverPassword),
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies OpenCodeSettings;
    const probeRuntime = (probeEnv: NodeJS.ProcessEnv) =>
      probeOpenCodeRuntime(effectiveConfig, probeEnv).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      );
    const resolveExecutable = yield* SpawnExecutableResolution;
    const platform = yield* HostProcess.Platform;
    const localExecutableIdentity = (env: NodeJS.ProcessEnv) => {
      const path = resolveExecutable(effectiveConfig.binaryPath, platform, env);
      if (path === undefined) return Effect.succeed({ path: effectiveConfig.binaryPath });
      return fileSystem.stat(path).pipe(
        Effect.map((stat) => ({
          path,
          dev: String(stat.dev),
          ino: Option.match(stat.ino, { onNone: () => null, onSome: String }),
          mtime: Option.match(stat.mtime, { onNone: () => null, onSome: (date) => date.getTime() }),
          size: String(stat.size),
        })),
        Effect.orElseSucceed(() => ({ path })),
      );
    };
    const executableIdentity = (env: NodeJS.ProcessEnv) =>
      effectiveConfig.serverUrl.trim().length > 0
        ? Effect.succeed(null)
        : localExecutableIdentity(env);
    const runtimeProbe = yield* makeOpenCodeRuntimeProbe(
      probeEnvironment.pipe(Effect.flatMap(probeRuntime)),
      currentEnvironment,
      executableIdentity,
    );
    const resolveRuntime =
      effectiveConfig.serverUrl.trim().length > 0
        ? runtimeProbe.get
        : Effect.gen(function* () {
            const identity = yield* runtimeProbe.identity;
            const cached = yield* runtimeProbe.lastSuccessAt(identity);
            const result = Option.isSome(cached)
              ? cached.value
              : yield* probeRuntime(yield* currentEnvironment);
            if ((yield* runtimeProbe.identity) !== identity) {
              return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "resolveRuntime",
                detail: "The OpenCode executable changed during its version check; try again.",
              });
            }
            if (Option.isNone(cached)) yield* runtimeProbe.recordAt(identity, result);
            return result;
          });
    const noUpdate = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });
    const maintenanceFor = (
      probedFor: (env: NodeJS.ProcessEnv) => typeof runtimeProbe.get,
      lookupEnvironment = currentEnvironment,
    ) =>
      lookupEnvironment.pipe(
        Effect.flatMap((env) =>
          probedFor(env).pipe(
            Effect.map((result) => result.generation),
            Effect.option,
            Effect.flatMap((generation) =>
              Option.isNone(generation)
                ? Effect.succeed(noUpdate)
                : resolveProviderMaintenanceCapabilitiesEffect(
                    openCodeUpdateFor(generation.value),
                    { binaryPath: effectiveConfig.binaryPath, env },
                  ),
            ),
            Effect.provideService(LaunchEnvironment, env),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
    // A loopback server can outlive its CLI installation, so its maintenance probes the local CLI,
    // under the environment of the lookup it serves.
    const maintenanceProbe = (env: NodeJS.ProcessEnv) =>
      isLocalOpenCodeServerUrl(effectiveConfig.serverUrl)
        ? probeOpenCodeBinary(effectiveConfig.binaryPath, providerProbeEnvironment(env)).pipe(
            Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
            Effect.catch(() => runtimeProbe.get),
          )
        : runtimeProbe.get;
    const cachedMaintenance = yield* makeCachedProviderMaintenanceResolution(
      maintenanceFor(maintenanceProbe),
      {
        // The probe identity fingerprints the executable and the merged environment; the hash of
        // the host snapshot resolveMaintenance provides joins it, because a native install's npm
        // advisory reads the host environment, where an instance override can mask a change.
        // A loopback server's maintenance probes the local CLI, so that executable joins the key.
        lookup: Effect.all({
          env: currentEnvironment,
          identity: runtimeProbe.identity,
          host: HostProcess.Environment,
        }).pipe(
          Effect.flatMap(({ env, identity, host }) =>
            Effect.gen(function* () {
              return isLocalOpenCodeServerUrl(effectiveConfig.serverUrl)
                ? yield* localExecutableIdentity(env)
                : null;
            }).pipe(
              Effect.map((local) => ({
                env,
                resolvedCommandPath: null,
                install: `${identity}\0${JSON.stringify(local)}\0${hostEnvironmentHash(host)}`,
              })),
            ),
          ),
        ),
        resolve: ({ env }) => maintenanceFor(maintenanceProbe, Effect.succeed(env)),
      },
    );
    const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
      !effectiveConfig.enabled
        ? Effect.succeed(noUpdate)
        : Effect.suspend(() => {
            const snapshot = { ...hostEnvironment };
            return makeCurrentLaunchEnvironment(environment, snapshot, home).pipe(
              Effect.flatMap((env) =>
                (options?.fresh === true
                  ? runtimeProbe.refresh.pipe(
                      Effect.ignore,
                      Effect.andThen(cachedMaintenance({ fresh: true })),
                    )
                  : cachedMaintenance()
                ).pipe(Effect.provideService(LaunchEnvironment, env)),
              ),
              Effect.provideService(HostProcess.Environment, snapshot),
            );
          });
    const openCodeV1Adapter = yield* OpenCodeAdapterV2.OpenCodeAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config: effectiveConfig,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build OpenCode orchestration adapter.",
            cause,
          }),
      ),
    );
    const openCode2Server = yield* OpenCode2Server.make({
      binaryPath: effectiveConfig.binaryPath,
      serverUrl: effectiveConfig.serverUrl,
      serverPassword: effectiveConfig.serverPassword,
      directory: host.paths.cwd,
      environment: processEnv,
      currentEnvironment,
    }).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      Effect.provideService(
        OpenCode2Client.OpenCode2Client,
        yield* OpenCode2Client.make.pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      ),
    );
    const openCode2ProbeServer = yield* OpenCode2Server.make({
      binaryPath: effectiveConfig.binaryPath,
      serverUrl: effectiveConfig.serverUrl,
      serverPassword: effectiveConfig.serverPassword,
      directory: host.paths.cwd,
      environment: providerProbeEnvironment(processEnv),
      currentEnvironment: probeEnvironment,
    }).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
      Effect.provideService(
        OpenCode2Client.OpenCode2Client,
        yield* OpenCode2Client.make.pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      ),
    );
    const orchestrationAdapter = selectOpenCodeRuntimeAdapter({
      probe: runtimeProbe,
      resolve: resolveRuntime,
      currentEnvironment,
      v1: openCodeV1Adapter,
      v2: yield* OpenCode2AdapterV2.make(instanceId).pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
      ),
      // Sessions belong to the build that opened them: a rebuild closes this build's server
      // owner, so ProviderSessionRetirement retires them even when the settings came back unchanged.
      sessionConfigKey: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
      runningVersion: openCode2Server.runningVersion ?? Effect.undefined,
    });
    const loadOpenCode2Models = yield* makeOpenCode2ModelLoader(
      (launch: OpenCodeServerOwner.OpenCodeServerLaunch | undefined, boundRead) =>
        openCode2ProbeServer.withConnection(
          ({ client }) => boundRead(loadOpenCode2Catalog(client, host.paths.cwd)),
          launch,
        ),
      openCode2ProbeServer.captureLaunch ??
        Effect.succeed(undefined as OpenCodeServerOwner.OpenCodeServerLaunch | undefined),
      (left, right) =>
        left === undefined || right === undefined
          ? left === right
          : OpenCodeServerOwner.sameOpenCodeServerLaunch(left, right),
      currentEnvironment,
    );
    // No location: OpenCode answers with the machine's global skills, which hold for every cwd.
    const loadOpenCode2Skills = loadOpenCode2GlobalSkills(
      openCode2ProbeServer.withConnection(({ client }) =>
        client.skill.list().pipe(
          Effect.map((list) => list.data),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "skill.list",
                detail: "The OpenCode server could not list its skills.",
                cause,
              }),
          ),
        ),
      ),
    );
    const listOpenCode2Workspace = (cwd: string) =>
      openCode2ProbeServer.withConnection(({ client, events }) =>
        Effect.gen(function* () {
          // OpenCode names a location by its resolved path (no trailing slash or `..`).
          const directory = pathService.resolve(cwd);
          const location = { directory };
          const scanned = yield* Deferred.make<void>();
          const pending = new Set(["command.updated", "skill.updated"]);
          const stream = yield* events.pipe(Effect.option);
          if (stream._tag === "Some") {
            yield* stream.value.pipe(
              Stream.runForEach((event) =>
                "location" in event &&
                event.location?.directory === directory &&
                pending.delete(event.type) &&
                pending.size === 0
                  ? Deferred.succeed(scanned, undefined)
                  : Effect.void,
              ),
              Effect.ignore,
              Effect.forkScoped,
            );
          }
          return yield* loadOpenCode2Workspace(
            Effect.all(
              {
                skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
                commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
              },
              { concurrency: "unbounded" },
            ),
            Deferred.await(scanned),
            // Without events no scan can be awaited, so trust the first read as before.
            stream._tag === "None"
              ? Effect.succeed(true)
              : client.debug.location.list().pipe(
                  Effect.map((loaded) => loaded.some((entry) => entry.directory === directory)),
                  Effect.timeout("2 seconds"),
                  Effect.orElseSucceed(() => true),
                ),
            // OpenCode answers provider.list for a location only once its skill scan has ended.
            client.provider.list({ location }).pipe(Effect.timeout("10 seconds"), Effect.ignore),
            yield* currentEnvironment,
          );
        }).pipe(Effect.scoped),
      );
    const serverOwner = yield* OpenCodeServerOwner.make({
      binaryPath: effectiveConfig.binaryPath,
      directory: host.paths.cwd,
      ...(effectiveConfig.serverPassword ? { serverPassword: effectiveConfig.serverPassword } : {}),
      environment: processEnv,
      currentEnvironment,
    });
    const probeServerOwner = yield* OpenCodeServerOwner.make({
      binaryPath: effectiveConfig.binaryPath,
      directory: host.paths.cwd,
      ...(effectiveConfig.serverPassword ? { serverPassword: effectiveConfig.serverPassword } : {}),
      environment: providerProbeEnvironment(processEnv),
      currentEnvironment: probeEnvironment,
    });
    const textGeneration = selectOpenCodeRuntimeTextGeneration(
      resolveRuntime,
      currentEnvironment,
      {
        providerInstanceId: instanceId,
        ...(host.environmentId === undefined ? {} : { environmentId: host.environmentId }),
      },
      effectiveConfig.serverUrl.trim().length > 0,
      effectiveConfig.binaryPath,
      yield* makeOpenCodeTextGeneration(effectiveConfig, {
        environment: processEnv,
        currentEnvironment,
        memoryRunnerContext: {
          providerInstanceId: instanceId,
          ...(host.environmentId === undefined ? {} : { environmentId: host.environmentId }),
        },
      }).pipe(Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner)),
      yield* OpenCode2TextGeneration.make({
        external: effectiveConfig.serverUrl.trim().length > 0,
        memoryRunnerContext: {
          providerInstanceId: instanceId,
          ...(host.environmentId === undefined ? {} : { environmentId: host.environmentId }),
        },
      }).pipe(Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server)),
    );

    const legacyUsageLimits = currentEnvironment.pipe(
      Effect.flatMap((environment) =>
        readOpenCodeGoUsageLimits({
          enabled: effectiveConfig.enabled,
          serverUrl: effectiveConfig.serverUrl,
          environment,
        }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Crypto.Crypto, crypto),
    );
    let unsupportedUsageVersion: string | undefined;
    // One environment per usage check, whether it runs inside a status check or on its own.
    const checkUsageLimits = currentEnvironment.pipe(
      Effect.flatMap((environment) =>
        Effect.gen(function* () {
          if (!effectiveConfig.enabled) return yield* legacyUsageLimits;
          const runtime = yield* runtimeProbe.get;
          if (runtime.generation === "v1" || runtime.version === unsupportedUsageVersion)
            return yield* legacyUsageLimits;
          const limits = yield* openCode2ProbeServer.withConnection((connection) =>
            connection.usageLimits(host.paths.cwd),
          );
          if (limits === undefined) unsupportedUsageVersion = runtime.version;
          return limits === undefined ? yield* legacyUsageLimits : withGoatUsageScopes(limits);
        }).pipe(Effect.provideService(LaunchEnvironment, environment)),
      ),
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        Effect.map(DateTime.now, (now) => ({
          checkedAt: DateTime.formatIso(now),
          windows: [],
          unavailable: {
            reason: "probeFailed" as const,
            message: "OpenCode could not read workspace usage.",
          },
        })),
      ),
    );
    const checkProvider = currentEnvironment.pipe(
      Effect.flatMap((environment) =>
        Effect.all(
          {
            // A configured loopback server reports its running version. Probe the local
            // CLI separately so a completed npm update is not mistaken for a failure
            // while that independently managed server still runs the previous binary.
            installedVersion:
              effectiveConfig.enabled && isLocalOpenCodeServerUrl(effectiveConfig.serverUrl)
                ? probeOpenCodeBinary(
                    effectiveConfig.binaryPath,
                    providerProbeEnvironment(environment),
                  ).pipe(
                    Effect.map((probed) => probed.version),
                    Effect.orElseSucceed(() => undefined),
                  )
                : Effect.void,
            provider: checkOpenCodeProviderStatus(
              effectiveConfig,
              host.paths.cwd,
              runtimeProbe.refresh,
              loadOpenCode2Models,
              loadOpenCode2Skills,
              environment,
            ).pipe(
              Effect.annotateLogs({ providerInstanceId: instanceId }),
              Effect.annotateSpans({ providerInstanceId: instanceId }),
            ),
            usageLimits: checkUsageLimits,
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(LaunchEnvironment, environment)),
      ),
      Effect.map(({ provider, usageLimits, installedVersion }) => ({
        ...provider,
        usageLimits,
        ...(installedVersion === undefined ? {} : { installedVersion }),
      })),
      Effect.map(stampIdentity),
      Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, probeServerOwner),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
    );
    // The CLI writes its full JSON inventory to stdout, but the Bun-compiled binary does not
    // flush more than one 64KB pipe buffer to a non-TTY stdout, so the piped output arrives
    // truncated and unparseable — which degrades to an empty skill list and poisons the workspace
    // snapshot the `$` picker reads.
    const loadWorkspaceInventory = (
      client: Parameters<typeof OpenCodeRuntime.loadOpenCodeCommands>[0],
    ) =>
      Effect.all(
        {
          skills: openCodeRuntime.loadOpenCodeSkills(client),
          commandInventory: currentEnvironment.pipe(
            Effect.flatMap((environment) =>
              OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
                Effect.timeoutOption(
                  resolveProviderProbeTimeoutMs("opencode", 10_000, environment),
                ),
              ),
            ),
            Effect.map((commands) => ({
              commands: Option.getOrElse(commands, () => []),
              slashCommandsPending: Option.isNone(commands),
            })),
            // SDK errors leave command discovery to the provider's health.
            Effect.orElseSucceed(() => ({
              commands: [],
              slashCommandsPending: undefined,
            })),
          ),
          // A project's opencode.jsonc can define its own providers.
          models: OpenCodeRuntime.loadOpenCodeProviderCatalog(client).pipe(
            Effect.timeoutOption("10 seconds"),
            Effect.map(
              Option.flatMapNullishOr((catalog) =>
                openCodeProviderModels(effectiveConfig, catalog),
              ),
            ),
            Effect.orElseSucceed(() => Option.none<ReadonlyArray<ServerProviderModel>>()),
          ),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ skills, commandInventory, models }) => ({
          skills,
          models,
          ...commandInventory,
        })),
      );
    const loadWorkspaceForCwd = (cwd: string) =>
      effectiveConfig.serverUrl.trim().length > 0
        ? Effect.scoped(
            Effect.gen(function* () {
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath: effectiveConfig.binaryPath,
                directory: cwd,
                serverUrl: effectiveConfig.serverUrl,
                ...(effectiveConfig.serverPassword
                  ? { serverPassword: effectiveConfig.serverPassword }
                  : {}),
                environment: yield* currentEnvironment,
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: cwd,
                ...(effectiveConfig.serverPassword
                  ? { serverPassword: effectiveConfig.serverPassword }
                  : {}),
              });
              return yield* loadWorkspaceInventory(client);
            }),
          )
        : probeServerOwner.withServer((server) =>
            loadWorkspaceInventory(
              openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory: cwd,
                ...(server.serverPassword !== undefined
                  ? { serverPassword: server.serverPassword }
                  : {}),
              }),
            ),
          );

    // Both servers verified the configured URL's version; the probe server is GOAT's discovery copy.
    const forgetServers = Effect.all([openCode2Server.forget, openCode2ProbeServer.forget], {
      discard: true,
    });
    const serverUrl = effectiveConfig.serverUrl.trim();
    const afterUpdate =
      serverUrl.length > 0
        ? currentEnvironment.pipe(
            Effect.flatMap((environment) =>
              replaceOutdatedService({
                binaryPath: effectiveConfig.binaryPath,
                serverUrl,
                environment,
              }),
            ),
            Effect.ensuring(forgetServers),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Failed to replace the OpenCode service after an update.",
                  cause,
                }),
            ),
            Effect.provideService(AgentScope, agentScope),
            Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, openCodeRuntime),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, pathService),
          )
        : Effect.void;

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenCodeSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      checkProviderOnSettingsChange: () => false,
      // A failed or still-loading catalog must recover without a manual
      // refresh. Healthy instances need no recurring server starts.
      refreshOnInterval: (snapshot) =>
        snapshot.enabled &&
        snapshot.installed &&
        snapshot.status !== "ready" &&
        snapshot.auth.status === "unknown",
      initialSnapshot: (settings) =>
        makePendingOpenCodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      checkUsageLimits,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : currentEnvironment.pipe(
              Effect.flatMap((environment) =>
                runtimeProbe.get.pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to probe OpenCode for '${cwd}'`,
                        cause,
                      }),
                  ),
                  Effect.flatMap((probed) =>
                    byOpenCodeRuntime(Effect.succeed(probed), {
                      v2: Effect.all(
                        [
                          snapshot.getSnapshot,
                          // A project's opencode.jsonc can define its own providers.
                          readSettledOpenCode2Catalog(
                            openCode2ProbeServer.withConnection(({ client }) =>
                              loadOpenCode2DirectoryCatalog(client, pathService.resolve(cwd)),
                            ),
                            environment,
                          ).pipe(
                            Effect.map(
                              Option.map((catalog) =>
                                openCode2ProviderModels(effectiveConfig, catalog),
                              ),
                            ),
                          ),
                          listOpenCode2Workspace(cwd).pipe(
                            // Leaves room for the reads around the scan wait, which uses the same override.
                            Effect.timeout(
                              2 * resolveProviderProbeTimeoutMs("opencode", 10_000, environment),
                            ),
                            Effect.mapError(
                              (cause) =>
                                new ProviderDriverError({
                                  driver: DRIVER_KIND,
                                  instanceId,
                                  detail: `Failed to list OpenCode commands and skills for '${cwd}'`,
                                  cause,
                                }),
                            ),
                          ),
                        ],
                        { concurrency: "unbounded" },
                      ).pipe(
                        Effect.map(([machineSnapshot, cwdModels, { skills, commands }]) => ({
                          ...machineSnapshot,
                          ...workspaceModelsFor(machineSnapshot.models, cwdModels),
                          skills: openCode2SkillsToServerProviderSkills(skills),
                          slashCommands: openCode2CommandsToServerProviderSlashCommands(commands),
                          // A finished scan lists at least the built-ins. None means it
                          // timed out, so the registry decides from the provider's health.
                          slashCommandsPending: commands.length > 0 ? false : undefined,
                        })),
                      ),
                      v1: Effect.all([
                        snapshot.getSnapshot,
                        loadWorkspaceForCwd(cwd).pipe(
                          // Leaves room for connection setup before the command fallback below.
                          Effect.timeout(
                            2 * resolveProviderProbeTimeoutMs("opencode", 10_000, environment),
                          ),
                        ),
                      ]).pipe(
                        Effect.map(
                          ([
                            machineSnapshot,
                            { skills, models, commands, slashCommandsPending },
                          ]) => ({
                            ...machineSnapshot,
                            ...workspaceModelsFor(machineSnapshot.models, models),
                            skills: openCodeSkillsToServerProviderSkills(skills),
                            slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
                            slashCommandsPending,
                          }),
                        ),
                        Effect.mapError(
                          (cause) =>
                            new ProviderDriverError({
                              driver: DRIVER_KIND,
                              instanceId,
                              detail: `Failed to probe OpenCode commands and skills for '${cwd}'`,
                              cause,
                            }),
                        ),
                      ),
                    }),
                  ),
                  Effect.provideService(LaunchEnvironment, environment),
                ),
              ),
            ),
      invalidateCaches: forgetServers,
      afterUpdate,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
