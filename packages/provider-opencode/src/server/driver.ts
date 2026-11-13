import { settingsSecretLiteral } from "@goat/contracts";
import { ProviderDriverKind, TextGenerationError } from "@goat/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCode2TextGeneration from "./v2/textGeneration.ts";
import { makeOpenCodeTextGeneration } from "./textGeneration.ts";
import {
  MemoryGenerationRunnerError,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import * as HostProcess from "@goat/shared/HostProcess";
import * as OpenCodeAdapterV2 from "./adapter.ts";
import * as OpenCode2AdapterV2 from "./v2/adapter.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@goat/provider-core/server/textGeneration";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import { openCodeUsageReader, type OpenCodeUsageReaderEnv } from "./usage.ts";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
import { loadOpenCode2Catalog } from "./openCode2Catalog.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2GlobalSkills,
  loadOpenCode2Workspace,
  makeOpenCode2ModelLoader,
  makePendingOpenCodeProvider,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2SkillsToServerProviderSkills,
  openCodeSkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
} from "./status.ts";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  makeOpenCodeRuntimeProbe,
  probeOpenCodeRuntime,
  type ProbedOpenCode,
} from "./versionProbe.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import * as OpenCode2Client from "./v2/OpenCode2Client.ts";
import * as OpenCode2Server from "./v2/OpenCode2Server.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@goat/provider-core/server/driver";
import { withInstanceIdentity } from "@goat/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import { providerProbeEnvironment } from "@goat/provider-core/server/snapshotProbe";
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

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

/** Update only within the installed package generation; 2.x converts the shared database in place. */
export const openCodeUpdateFor = (generation: ProbedOpenCode["generation"]) =>
  makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: generation === "v2" ? "@opencode/cli" : "opencode-ai",
    nativeUpdate: {
      args: ["upgrade"],
      isCommandPath: isOpenCodeNativeCommandPath,
      requiresCommandPath: true,
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

// Hot reads use the last successful probe; session opens await it to select the correct protocol.
function selectOpenCodeRuntimeAdapter(input: {
  readonly probe: OpenCodeRuntimeProbe;
  readonly resolve: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>;
  readonly v1: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly v2: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly sessionConfigKey: string;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const pick = <PE>(probed: Effect.Effect<ProbedOpenCode | undefined, PE>) =>
    byOpenCodeRuntime(probed, { v1: Effect.succeed(input.v1), v2: Effect.succeed(input.v2) });
  const hot = pick(Effect.map(input.probe.lastSuccess, Option.getOrUndefined));
  return {
    instanceId: input.v1.instanceId,
    driver: DRIVER_KIND,
    sessionConfigKey: input.sessionConfigKey,
    getCapabilities: () => Effect.flatMap(hot, (adapter) => adapter.getCapabilities()),
    planSelectionTransition: (transition) =>
      Effect.flatMap(hot, (adapter) => adapter.planSelectionTransition(transition)),
    openSession: (session) =>
      Effect.flatMap(pick(input.resolve), (adapter) => adapter.openSession(session)),
  };
}

function selectOpenCodeRuntimeTextGeneration(
  probe: OpenCodeRuntimeProbe,
  resolve: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>,
  v1: ProviderTextGeneration,
  v2: ProviderTextGeneration,
): ProviderTextGeneration {
  // Memory preflight must not start a probe/server before the identity/isolation gates.
  const memoryProbe = Effect.map(probe.lastSuccess, Option.getOrUndefined);
  const unsupportedMemory = (operation: MemoryOperationName) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "The selected OpenCode runtime has no memory runner.",
        cause: new MemoryGenerationRunnerError({ code: "unsupported_operation" }),
      }),
    );
  return {
    resolveMemoryConflict: (input) =>
      byOpenCodeRuntime(memoryProbe, {
        v1:
          v1.resolveMemoryConflict === undefined
            ? unsupportedMemory("resolveMemoryConflict")
            : v1.resolveMemoryConflict(input),
        v2:
          v2.resolveMemoryConflict === undefined
            ? unsupportedMemory("resolveMemoryConflict")
            : v2.resolveMemoryConflict(input),
      }),
    generateMemorySummary: (input) =>
      byOpenCodeRuntime(memoryProbe, {
        v1:
          v1.generateMemorySummary === undefined
            ? unsupportedMemory("generateMemorySummary")
            : v1.generateMemorySummary(input),
        v2:
          v2.generateMemorySummary === undefined
            ? unsupportedMemory("generateMemorySummary")
            : v2.generateMemorySummary(input),
      }),
    generateCommitMessage: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateCommitMessage(input),
        v2: v2.generateCommitMessage(input),
      }),
    generatePrContent: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generatePrContent(input),
        v2: v2.generatePrContent(input),
      }),
    generateBranchName: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateBranchName(input),
        v2: v2.generateBranchName(input),
      }),
    generateThreadTitle: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateThreadTitle(input),
        v2: v2.generateThreadTitle(input),
      }),
    generateReviewGuide: (input) =>
      byOpenCodeRuntime(resolve, {
        v1: v1.generateReviewGuide(input),
        v2: v2.generateReviewGuide(input),
      }),
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
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const crypto = yield* Crypto.Crypto;
    const host = yield* ProviderHost.ProviderHost;
    const hostEnvironment = yield* HostProcess.Environment;
    const currentEnvironment = mergeProviderInstanceEnvironment(environment, hostEnvironment).pipe(
      Effect.provideService(HostProcess.HomeDirectory, yield* HostProcess.HomeDirectory),
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
    const runtimeProbe = yield* makeOpenCodeRuntimeProbe(
      probeEnvironment.pipe(Effect.flatMap(probeRuntime)),
    );
    const resolveRuntime =
      effectiveConfig.serverUrl.trim().length > 0
        ? runtimeProbe.get
        : runtimeProbe.lastSuccess.pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  currentEnvironment.pipe(
                    Effect.flatMap(probeRuntime),
                    Effect.tap(runtimeProbe.record),
                  ),
              }),
            ),
          );
    const noUpdate = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });
    const maintenanceFor = (probed: typeof runtimeProbe.get) =>
      probed.pipe(
        Effect.map((result) => result.generation),
        Effect.option,
        Effect.flatMap((generation) =>
          Option.isNone(generation)
            ? Effect.succeed(noUpdate)
            : currentEnvironment.pipe(
                Effect.flatMap((env) =>
                  resolveProviderMaintenanceCapabilitiesEffect(
                    openCodeUpdateFor(generation.value),
                    {
                      binaryPath: effectiveConfig.binaryPath,
                      env,
                    },
                  ),
                ),
              ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
    const cachedMaintenance = yield* makeCachedProviderMaintenanceResolution(
      maintenanceFor(runtimeProbe.get),
    );
    const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
      !effectiveConfig.enabled
        ? Effect.succeed(noUpdate)
        : options?.fresh === true
          ? runtimeProbe.refresh.pipe(
              Effect.ignore,
              Effect.andThen(cachedMaintenance({ fresh: true })),
            )
          : cachedMaintenance();
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
      v1: openCodeV1Adapter,
      v2: yield* OpenCode2AdapterV2.make(instanceId).pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, openCode2Server),
      ),
      // Sessions belong to the build that opened them: a rebuild closes this build's server
      // owner, so ProviderSessionRetirement retires them even when the settings came back unchanged.
      sessionConfigKey: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
    });
    const loadOpenCode2Models = yield* makeOpenCode2ModelLoader(
      openCode2ProbeServer.withConnection(({ client }) =>
        loadOpenCode2Catalog(client, host.paths.cwd),
      ),
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
          const location = { directory: cwd };
          const scanned = yield* Deferred.make<void>();
          const pending = new Set(["command.updated", "skill.updated"]);
          const stream = yield* events.pipe(Effect.option);
          if (stream._tag === "Some") {
            yield* stream.value.pipe(
              Stream.runForEach((event) =>
                "location" in event &&
                event.location?.directory === cwd &&
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
          );
        }).pipe(Effect.scoped),
      );
    const serverOwner = yield* OpenCodeServerOwner.make({
      binaryPath: effectiveConfig.binaryPath,
      directory: host.paths.cwd,
      ...(effectiveConfig.serverPassword ? { serverPassword: effectiveConfig.serverPassword } : {}),
      environment: processEnv,
    });
    const probeServerOwner = yield* OpenCodeServerOwner.make({
      binaryPath: effectiveConfig.binaryPath,
      directory: host.paths.cwd,
      ...(effectiveConfig.serverPassword ? { serverPassword: effectiveConfig.serverPassword } : {}),
      environment: providerProbeEnvironment(processEnv),
      currentEnvironment: probeEnvironment,
    });
    const textGeneration = selectOpenCodeRuntimeTextGeneration(
      runtimeProbe,
      resolveRuntime,
      yield* makeOpenCodeTextGeneration(effectiveConfig, {
        environment: processEnv,
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

    const checkUsageLimits = readOpenCodeGoUsageLimits({
      enabled: effectiveConfig.enabled,
      serverUrl: effectiveConfig.serverUrl,
      environment: processEnv,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Crypto.Crypto, crypto),
    );
    const checkProvider = Effect.all(
      {
        provider: checkOpenCodeProviderStatus(
          effectiveConfig,
          host.paths.cwd,
          runtimeProbe.refresh,
          loadOpenCode2Models,
          loadOpenCode2Skills,
        ).pipe(
          Effect.annotateLogs({ providerInstanceId: instanceId }),
          Effect.annotateSpans({ providerInstanceId: instanceId }),
        ),
        usageLimits: checkUsageLimits,
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(({ provider, usageLimits }) => ({ ...provider, usageLimits })),
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
          commandInventory: OpenCodeRuntime.loadOpenCodeCommands(client).pipe(
            Effect.timeoutOption("10 seconds"),
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
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ skills, commandInventory }) => ({
          skills,
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
                environment: processEnv,
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
          : runtimeProbe.get.pipe(
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
                  v2: Effect.all([
                    snapshot.getSnapshot,
                    listOpenCode2Workspace(cwd).pipe(
                      Effect.timeout("20 seconds"),
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
                  ]).pipe(
                    Effect.map(([machineSnapshot, { skills, commands }]) => ({
                      ...machineSnapshot,
                      skills: openCode2SkillsToServerProviderSkills(skills),
                      slashCommands: openCode2CommandsToServerProviderSlashCommands(commands),
                      // A finished scan lists at least the built-ins. None means it
                      // timed out, so the registry decides from the provider's health.
                      slashCommandsPending: commands.length > 0 ? false : undefined,
                    })),
                  ),
                  v1: Effect.all([
                    snapshot.getSnapshot,
                    loadWorkspaceForCwd(cwd).pipe(Effect.timeout("20 seconds")),
                  ]).pipe(
                    Effect.map(([machineSnapshot, { skills, commands, slashCommandsPending }]) => ({
                      ...machineSnapshot,
                      skills: openCodeSkillsToServerProviderSkills(skills),
                      slashCommands: openCodeCommandsToServerProviderSlashCommands(commands),
                      slashCommandsPending,
                    })),
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
            ),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
