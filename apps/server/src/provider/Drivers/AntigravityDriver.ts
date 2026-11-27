import {
  mergeThreadEnvironment,
  withAgentDeviceEnvironment,
} from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderSetupError,
  RuntimeMode,
  settingsSecretLiteral,
} from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import {
  NodeRuntimeUnavailableError,
  nodeRuntimeUnavailableMessage,
} from "@goat/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";
import * as AcpErrors from "effect-acp/errors";

import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import { brokenRuntimeError } from "../providerCompatibility.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  prepareAntigravityRuntimeHome,
  resolveAntigravityInstanceDirectories,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  antigravitySessionMode,
  antigravityServesGoat,
  antigravityModelOptions,
  antigravityThinkingConfig,
  makeAntigravityAcpRuntime,
  OPEN_MODEL_ACCESS_RELEASE,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@goat/provider-core/server/snapshotProbe";
import {
  acquireAntigravityRuntimeTemp,
  retireAntigravityRuntimeTempDirs,
  removeAntigravitySessionFiles,
} from "../acp/AntigravitySessionFiles.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import { makeAntigravityAdapterV2 } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@goat/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import {
  AntigravityProbeIncompatibility,
  makeAntigravityProvider,
} from "../AntigravityProvider.ts";
import { makeAntigravityUsageProbe } from "../antigravityUsageLimits.ts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ModelCatalog from "@goat/provider-core/server/ModelCatalog";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@goat/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@goat/provider-core/server/instanceIdentity";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const isNodeRuntimeUnavailableError = Schema.is(NodeRuntimeUnavailableError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isAcpErrorDetails = Schema.is(Schema.Struct({ details: Schema.String }));
const RememberedRuntimeModes = Schema.fromJsonString(
  Schema.Struct({ authMethod: Schema.String, modes: Schema.Array(RuntimeMode) }),
);
const decodeRememberedRuntimeModes = Schema.decodeUnknownOption(RememberedRuntimeModes);
const encodeRememberedRuntimeModes = Schema.encodeSync(RememberedRuntimeModes);
const REFRESH_FAILED =
  "Could not refresh Antigravity models. The previous model list is unchanged.";
const PYTHON_SOCKS_REQUIRED = "python-socks is required to use a SOCKS proxy";

// Keep upstream diagnostics in cause; only recognized, fixed text reaches clients.
function refreshFailureDetail(cause: unknown) {
  return isAcpRequestError(cause) &&
    cause.operation === "receive-response" &&
    isAcpErrorDetails(cause.data) &&
    cause.data.details.includes(PYTHON_SOCKS_REQUIRED)
    ? `${REFRESH_FAILED} Antigravity reported: ${PYTHON_SOCKS_REQUIRED}`
    : REFRESH_FAILED;
}

export type AntigravityDriverEnv =
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const AntigravityDriver: ProviderDriver<
  AntigravitySettings,
  AntigravityDriverEnv,
  AntigravityUsage.AntigravityUsage
> = {
  driverKind: DRIVER,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  create: Effect.fn("AntigravityDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const selfInvocation = yield* resolveSelfInvocation();
    const installation = yield* AntigravityInstallation.AntigravityInstallation;
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER);
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const settings = { ...config, enabled } satisfies AntigravitySettings;
    const auth: AntigravityAuthConfig = {
      authMethod: settings.authMethod,
      apiKey: settingsSecretLiteral(settings.apiKey),
      gcpProject: settings.gcpProject,
      gcpLocation: settings.gcpLocation,
    };
    const authConfigIssue = antigravityAuthConfigIssue(auth);
    const baseEnvironment = yield* HostProcess.Environment;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const currentEnvironment = Effect.suspend(() =>
      mergeProviderInstanceEnvironment(environment, baseEnvironment),
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      Effect.map((env) => ({ ...env })),
    );
    const currentProfile = currentEnvironment.pipe(
      Effect.map((env) => resolveAntigravityUserHome(platform, env, homeDirectory)),
    );
    const startedProfiles = new WeakMap<AcpSessionRuntime.AcpSessionRuntimeStartResult, string>();
    const eventProfiles = new WeakMap<AcpSessionRuntime.AcpSessionRuntimeEvent, string>();
    const directories = yield* resolveAntigravityInstanceDirectories(
      host.paths.stateDir,
      instanceId,
    ).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not resolve the Antigravity profile directory.",
            cause,
          }),
      ),
    );
    const profileDirectory = directories.profile;
    // Only a session reports whether agy offers Auto, so keep the last answer across restarts.
    const runtimeModesPath = path.join(profileDirectory, "goat-runtime-modes.json");
    const rememberedRuntimeModes = yield* fileSystem.readFileString(runtimeModesPath).pipe(
      Effect.map((contents) =>
        decodeRememberedRuntimeModes(contents).pipe(
          Option.filter((saved) => saved.authMethod === auth.authMethod),
          Option.map((saved) => saved.modes),
          Option.getOrUndefined,
        ),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const directory of [
      directories.runtimeTemp,
      path.join(profileDirectory, "antigravity-acp", "tmp"),
    ]) {
      const removeRetired = yield* retireAntigravityRuntimeTempDirs(directory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* Effect.forkScoped(removeRetired);
    }
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const classifyModels = (draft: ServerProviderDraft) =>
      currentCatalog.pipe(
        Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),
      );

    const resolveLaunch = Effect.fn("AntigravityDriver.resolveLaunch")(function* (
      processEnvironment: NodeJS.ProcessEnv,
    ) {
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      return yield* installation.acquire(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
    });
    const prepareSpawn = Effect.fn("AntigravityDriver.prepareSpawn")(function* (
      input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
    ): Effect.fn.Return<
      {
        executable: AntigravityInstallation.AntigravityExecutable;
        spawn: AcpSessionRuntime.AcpSpawnInput;
        userHome: string;
      },
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      const processEnvironment = input.sessionEnvironment ?? (yield* currentEnvironment);
      const userHome = resolveAntigravityUserHome(platform, processEnvironment, homeDirectory);
      const executable =
        input.sessionLaunch === undefined
          ? yield* resolveLaunch(processEnvironment)
          : (input.sessionLaunch as AntigravityInstallation.AntigravityExecutable);
      const profile = yield* prepareAntigravityProfile({
        profileDirectory,
        baseEnv: processEnvironment,
        auth,
        userHome,
        tempDirectory: directories.runtimeTemp,
        skipUserSkills: true,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          isNodeRuntimeUnavailableError(cause.cause)
            ? new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
                cause,
              })
            : cause,
        ),
      );
      // Use one directory per process; shared cleanup could delete files another session still reads.
      // Remove after the child dies, best-effort on Windows where handles may outlive the kill;
      // the next driver start sweeps leftovers.
      const runtimeTempDirectory = yield* acquireAntigravityRuntimeTemp(profile.tempDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "start",
              detail:
                (cause.reason._tag === "Busy" ? cause.reason.description : undefined) ??
                "Could not create an Antigravity runtime temp directory.",
              cause,
            }),
        ),
      );
      const runtimeProfile = yield* prepareAntigravityRuntimeHome({
        directory: runtimeTempDirectory,
        profile,
        userHome,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      return {
        executable,
        userHome,
        spawn: buildAntigravityAcpSpawnInput({
          installation: executable,
          profile: runtimeProfile,
          cwd: input.cwd,
          baseEnv: mergeThreadEnvironment(
            withAgentDeviceEnvironment(processEnvironment, input),
            input.processEnvironment,
          ),
          auth,
          runtimeTempDirectory,
        }),
      };
    });

    const runtimeIncompatibility = Effect.fn("AntigravityDriver.runtimeIncompatibility")(function* (
      executable: AntigravityInstallation.AntigravityExecutable,
      version: string | null | undefined,
    ) {
      if (!version) return;
      const advisory = yield* installation.compatibility(version);
      const action =
        executable.source === "managed"
          ? "Update it in Antigravity setup"
          : `Update the Antigravity executable at ${executable.executablePath}`;
      const refused = brokenRuntimeError({
        instanceId,
        name: "Antigravity",
        version,
        advisory,
        action,
      });
      if (refused) return refused;
      if (!antigravityServesGoat(version)) {
        return new ProviderSetupError({
          instanceId,
          operation: "runtime",
          detail: `Antigravity ${version} only serves allowlisted editors, not GOAT. ${action} to ${OPEN_MODEL_ACCESS_RELEASE.join(".")} or newer, then retry.`,
        });
      }
    });

    const externalExecutableIdentity = Effect.fn("AntigravityDriver.externalExecutableIdentity")(
      function* (executablePath: string) {
        const target = yield* fileSystem.realPath(executablePath);
        const info = yield* fileSystem.stat(target);
        return {
          executablePath,
          target,
          device: info.dev,
          inode: info.ino.valueOrUndefined,
          size: info.size,
          modifiedAt: info.mtime.valueOrUndefined?.getTime(),
        };
      },
      Effect.orElseSucceed(() => undefined),
    );
    let nextExternalAttempt = 0;
    let completedExternalAttempt = 0;
    type ExternalExecutableIdentity = NonNullable<
      Effect.Success<ReturnType<typeof externalExecutableIdentity>>
    >;
    let rejectedExternalRuntime:
      | { readonly identity: ExternalExecutableIdentity; readonly version: string }
      | undefined;

    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
      input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
    ) {
      const { executable, spawn, userHome } = yield* prepareSpawn(input);
      const runtime = yield* makeAntigravityAcpRuntime({
        ...input,
        runtimeVersion: executable.version,
        authMethod: auth.authMethod,
        childProcessSpawner: spawner,
        spawn,
      }).pipe(Effect.provideService(SecureRandom.SecureRandom, random));
      const startCompatible = Effect.fn("AntigravityDriver.startCompatible")(function* () {
        // A launcher can select a different runtime based on the thread's environment.
        const observeVersion =
          executable.version === null && input.processEnvironment === undefined;
        const attempt = observeVersion ? ++nextExternalAttempt : 0;
        const identity = observeVersion
          ? yield* externalExecutableIdentity(executable.executablePath)
          : undefined;
        const version = (yield* runtime.initialize()).agentInfo?.version;
        const refused = yield* runtimeIncompatibility(executable, version);
        // An unversioned or late handshake cannot supersede a known version.
        if (version && identity && attempt > completedExternalAttempt) {
          completedExternalAttempt = attempt;
          rejectedExternalRuntime = refused ? { identity, version } : undefined;
        }
        if (refused) {
          return yield* new AcpErrors.AcpTransportError({ detail: refused.detail, cause: refused });
        }
        return yield* runtime.start();
      });
      return {
        ...runtime,
        getEvents: () =>
          runtime.getEvents().pipe(
            // Only the two catalog events read their session's profile; deltas pass untouched.
            Stream.tap((event) =>
              event._tag === "ConfigOptionsUpdated" || event._tag === "AvailableCommandsUpdated"
                ? Effect.sync(() => {
                    eventProfiles.set(event, userHome);
                  })
                : Effect.void,
            ),
          ),
        ...(executable.harnessPath === null
          ? {
              setMode: (modeId: string) =>
                runtime.getModeState.pipe(
                  Effect.flatMap((modeState) =>
                    runtime.setMode(antigravitySessionMode(modeId, modeState)),
                  ),
                ),
            }
          : {}),
        start: () =>
          startCompatible().pipe(
            Effect.tap((started) => Effect.sync(() => startedProfiles.set(started, userHome))),
            Effect.tapError((cause): Effect.Effect<void> =>
              input.onAuthorizationUrl === undefined && isAntigravitySignInRequiredError(cause)
                ? provider.onAuthRequired(userHome)
                : Effect.void,
            ),
          ),
      };
    });

    const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
      input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl">,
    ) {
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "goat-antigravity-setup-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      let sessionId: string | undefined;
      yield* Effect.addFinalizer(() =>
        removeAntigravitySessionFiles({
          profileDirectory,
          sessionId,
          cwd,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const sessionEnvironment = yield* currentEnvironment;
      const runtime = yield* makeRuntime({
        cwd,
        mcpServers: [],
        sessionEnvironment,
        ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
      });
      return {
        ...runtime,
        userHome: resolveAntigravityUserHome(platform, sessionEnvironment, homeDirectory),
        start: () =>
          runtime.start().pipe(
            Effect.tap((started) =>
              Effect.sync(() => {
                sessionId = started.sessionId;
              }),
            ),
          ),
      };
    });

    const codeLogin = Effect.fn("AntigravityDriver.codeLogin")(function* (input: {
      readonly onAuthorizationUrl: (url: string) => Effect.Effect<void, AcpErrors.AcpError>;
    }) {
      if (auth.authMethod !== "oauth-personal") return undefined;
      const environment = yield* currentEnvironment;
      const resolved = yield* installation
        .resolve(settings.binaryPath, environment)
        .pipe(Effect.option);
      if (Option.isSome(resolved) && resolved.value.harnessPath !== null) return undefined;
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "goat-antigravity-login-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
                cause,
              }),
          ),
        );
      const { executable, spawn } = yield* prepareSpawn({
        cwd,
        mcpServers: [],
        sessionEnvironment: environment,
      });
      if (executable.harnessPath !== null) return undefined;
      const failed = (detail: string, cause?: unknown) =>
        new ProviderSetupError({ instanceId, operation: "start", detail, cause });
      const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...env } = spawn.env ?? {};
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, [...spawn.args, "--login"], {
            cwd,
            env,
            extendEnv: false,
            shell: false,
          }),
        )
        .pipe(Effect.mapError((cause) => failed("Could not start Antigravity sign-in.", cause)));
      const code = yield* Deferred.make<string>();
      let submitted = false;
      const stdin = yield* Stream.fromEffect(Deferred.await(code)).pipe(
        Stream.map((response) => `${response}\n`),
        Stream.encodeText,
        Stream.run(child.stdin),
        Effect.forkScoped,
      );
      let pending = "";
      const handleLine = (line: string) =>
        line.trim().startsWith("https://accounts.google.com/")
          ? input.onAuthorizationUrl(line.trim())
          : Effect.void;
      const output = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const lines = `${pending}${chunk}`.split("\n");
            pending = lines.pop() ?? "";
            if (pending.length > 16384 || lines.some((line) => line.length > 16384)) {
              return yield* new AcpErrors.AcpTransportError({
                detail: "Antigravity sign-in output is too large.",
                cause: undefined,
              });
            }
            yield* Effect.forEach(lines, handleLine, { discard: true });
          }),
        ),
        Effect.andThen(Effect.suspend(() => handleLine(pending))),
        Effect.forkScoped,
      );
      const stderr = yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
      return {
        submit: (response: string) =>
          Effect.sync(() => {
            submitted = true;
          }).pipe(Effect.andThen(Deferred.succeed(code, response)), Effect.asVoid),
        completed: Effect.gen(function* () {
          yield* Fiber.join(output).pipe(
            Effect.mapError((cause) =>
              failed("Antigravity returned an invalid Google sign-in link.", cause),
            ),
          );
          const exitCode = yield* child.exitCode.pipe(
            Effect.mapError((cause) => failed("Antigravity sign-in stopped unexpectedly.", cause)),
          );
          if (Number(exitCode) !== 0 || !submitted)
            return yield* failed(
              "Antigravity could not finish Google sign-in. Start sign-in again.",
            );
          yield* Fiber.join(stdin).pipe(
            Effect.mapError((cause) => failed("Could not deliver the sign-in code.", cause)),
          );
          yield* Fiber.join(stderr).pipe(
            Effect.mapError((cause) => failed("Antigravity sign-in stopped unexpectedly.", cause)),
          );
        }),
      };
    });

    const publishCatalog = Effect.fn("AntigravityDriver.publishCatalog")(function* (
      started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
      runtime: Pick<
        AcpSessionRuntime.AcpSessionRuntime["Service"],
        "getEvents" | "drainEvents" | "setModel"
      >,
    ) {
      yield* provider.onSessionStarted(started, undefined, startedProfiles.get(started));
      yield* authFlow.onSignedInElsewhere;
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions, eventProfiles.get(event), {
            fromCatalogProbe: true,
          });
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(
              event.availableCommands,
              undefined,
              eventProfiles.get(event),
            )
          : Effect.void;
      }).pipe(Effect.forkScoped);
      // Thinking levels differ per model and are reported only for the selected one.
      const configOptions = started.sessionSetupResult.configOptions ?? [];
      const current = configOptions.find((option) => option.id === "model")?.currentValue;
      if (antigravityThinkingConfig(configOptions) !== undefined && typeof current === "string") {
        for (const model of [...antigravityModelOptions(configOptions), { value: current }]) {
          yield* runtime.setModel(model.value).pipe(Effect.ignore);
        }
      }
      yield* runtime.drainEvents;
    }, Effect.scoped);

    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
      instanceId,
      makeRuntime: makeDisposableRuntime,
      // A new sign-in may be another account; drop any in-flight quota read first.
      onAuthenticated: (started, runtime) =>
        Effect.suspend(() => provider.onSignedIn).pipe(
          Effect.andThen(publishCatalog(started, runtime)),
        ),
      onSignedOut: (runtime) => provider.onSignedOut(runtime.userHome),
      usesBrowser: antigravityAuthUsesBrowser(auth.authMethod),
      codeLogin,
    });

    // The probe must not spawn. The agent is a PyInstaller one-file bundle
    // that unpacks about 1 GB per launch, and the health check runs every
    // minute.
    const probe = Effect.gen(function* () {
      yield* modelCatalog.refreshInBackground;
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const processEnvironment = yield* currentEnvironment;
      const executable = yield* installation.resolve(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      const previousRejection = rejectedExternalRuntime;
      const identity =
        executable.version === null && previousRejection
          ? yield* externalExecutableIdentity(executable.executablePath)
          : undefined;
      const rememberedVersion =
        rejectedExternalRuntime && Equal.equals(rejectedExternalRuntime.identity, identity)
          ? rejectedExternalRuntime.version
          : undefined;
      const invalidatedVersion =
        previousRejection &&
        previousRejection === rejectedExternalRuntime &&
        identity &&
        rememberedVersion === undefined
          ? previousRejection.version
          : undefined;
      if (invalidatedVersion !== undefined || executable.version !== null) {
        rejectedExternalRuntime = undefined;
      }
      const version = executable.version ?? rememberedVersion;
      if (version) {
        const refused = yield* runtimeIncompatibility(executable, version);
        if (refused) {
          return yield* new AntigravityProbeIncompatibility({ version, detail: refused.detail });
        }
      }
      return {
        protocolVersion: 1,
        ...(invalidatedVersion === undefined ? {} : { invalidatedVersion }),
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: {
          name: "antigravity-acp",
          title: "Google Antigravity",
          version: version ?? "unknown",
        },
      };
    });

    const usage = yield* makeAntigravityUsageProbe({
      profileDirectory,
      authMethod: auth.authMethod,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const provider = yield* makeAntigravityProvider(settings, {
      environment: currentEnvironment,
      stampIdentity: classifyModels,
      probe,
      probeUsage: usage.probe,
      clearUsage: usage.clear,
      auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
      currentProfile,
      ...(rememberedRuntimeModes ? { rememberedRuntimeModes } : {}),
      rememberRuntimeModes: (modes) =>
        writeFileStringAtomically({
          filePath: runtimeModesPath,
          contents: encodeRememberedRuntimeModes({ authMethod: auth.authMethod, modes }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.catch(() => Effect.logWarning("Could not save Antigravity permission modes.")),
        ),
      supportsTextGeneration: isAntigravityTextGenerationAvailable(profileDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => false),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not prepare the Antigravity provider status.",
            cause,
          }),
      ),
    );
    const defaultModel = currentCatalog.pipe(Effect.map((catalog) => catalog?.defaultChatModel));
    const orchestrationAdapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation,
      makeRuntime,
      currentEnvironment,
      resolveSessionLaunch: (env) =>
        resolveLaunch(env).pipe(
          Effect.mapError(
            (cause) => new AcpErrors.AcpTransportError({ detail: cause.detail, cause }),
          ),
        ),
      withProcess: authFlow.withProcess,
      defaultModel,
      supportsNativeGoals: provider.snapshot.getSnapshot.pipe(
        Effect.map(
          (snapshot) => snapshot.slashCommands?.some((command) => command.name === "goal") === true,
        ),
      ),
      profileDirectory,
      onSessionStarted: (started, cwd, session) =>
        provider
          .onSessionStarted(started, cwd, startedProfiles.get(started), session)
          .pipe(Effect.andThen(authFlow.onSignedInElsewhere)),
      onSessionEvent: (event, cwd) => {
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions, eventProfiles.get(event));
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands, cwd, eventProfiles.get(event))
          : Effect.void;
      },
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: loggers.native,
          provider: DRIVER,
          threadId,
        }),
    });
    const textGeneration = yield* makeAntigravityTextGeneration({
      memoryRunnerContext: {
        providerInstanceId: instanceId,
        ...(host.environmentId === undefined ? {} : { environmentId: host.environmentId }),
      },
      profileDirectory,
      defaultModel,
      withProcess: authFlow.withProcess,
      makeRuntime: (cwd) =>
        makeRuntime({
          cwd,
          mcpServers: [],
        }),
    });

    const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
      function* () {
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
        yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* makeDisposableRuntime({});
              const started = yield* runtime.start();
              yield* publishCatalog(started, runtime);
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope));
      },
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        cause._tag === "ProviderDriverError"
          ? cause
          : new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: isAntigravitySignInRequiredError(cause)
                ? "Sign in to Antigravity in provider settings before refreshing models."
                : cause._tag === "ProviderSetupError" &&
                    (cause.operation === "configure" ||
                      cause.operation === "resolve" ||
                      cause.operation === "start")
                  ? cause.detail
                  : cause._tag === "AcpTransportError" &&
                      isProviderSetupError(cause.cause) &&
                      cause.cause.operation === "runtime"
                    ? cause.cause.detail
                    : refreshFailureDetail(cause),
              cause,
            }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: provider.snapshot,
      snapshotForCwd: (cwd) =>
        !enabled
          ? provider.snapshot.getSnapshot
          : currentEnvironment.pipe(
              Effect.flatMap((environment) =>
                discoverAntigravitySkills({
                  cwd,
                  userHome: resolveAntigravityUserHome(platform, environment, homeDirectory),
                  profileDirectory,
                }),
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER,
                    instanceId,
                    detail: "Could not read Antigravity workspace skills.",
                    cause,
                  }),
              ),
            ),
      orchestrationAdapter,
      textGeneration,
      auth: authFlow.controller,
      refreshModels,
    } satisfies ProviderInstance;
  }),
};
