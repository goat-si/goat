import { ProviderDriverKind, type CodexSettings } from "@goat/contracts";
import type {
  ProviderDriverCreateInput,
  ProviderInstance,
} from "@goat/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@goat/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import { createCodexAdapterV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import { resolveManagedCodexHomeLayout } from "../CodexManagedHome.ts";
import { resolveAuthlessManagedRuntime } from "../CodexManagedRuntime.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
} from "../CodexProvider.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as HomeRoute from "../OpenCodexRoute.ts";
import { codexContinuationIdentity } from "./CodexHomeLayout.ts";

const DRIVER = ProviderDriverKind.make("codex");

/** Managed Codex through OpenCodex Home with None: no ChatGPT sign-in, broker or token store. */
export const makeManagedHomeCodexProvider = Effect.fn("makeManagedHomeCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const { instanceId, enabled, displayName, accentColor, config } = input;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const installation = yield* CodexInstallation.CodexInstallation;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* ProviderHost.ProviderHost;
  const homeRoute = yield* Effect.serviceOption(HomeRoute.OpenCodexRoute);
  const environment = yield* mergeProviderInstanceEnvironment(input.environment);
  const homeLayout = yield* resolveManagedCodexHomeLayout(server.stateDir, instanceId, config);
  const continuationIdentity = codexContinuationIdentity(homeLayout);
  const stamp = withInstanceIdentity({
    instanceId,
    driverKind: DRIVER,
    displayName,
    accentColor,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const setup = { canAuthenticate: false, canInstall: true };
  const runtimePaths = {
    homePath: homeLayout.sharedHomePath,
    shadowHomePath:
      homeLayout.mode === "authOverlay"
        ? (homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath)
        : null,
  };
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, server),
      Effect.provideService(CodexInstallation.CodexInstallation, installation),
      (provided) =>
        Option.isSome(homeRoute)
          ? provided.pipe(Effect.provideService(HomeRoute.OpenCodexRoute, homeRoute.value))
          : provided,
    );
  const runtime = (acquisition: "acquire" | "installed") =>
    resolveAuthlessManagedRuntime({
      settings: { ...config, enabled },
      instanceId,
      environment,
      acquisition,
    }).pipe(provideHost);
  const resolveRuntime = runtime("acquire");
  const pending = makePendingCodexProvider({ ...config, enabled, customModels: [] }).pipe(
    Effect.map((draft) => stamp({ ...draft, models: [], setup, runtimePaths })),
  );
  const check = Effect.gen(function* () {
    const base = yield* pending;
    if (!enabled) return base;
    const installed = yield* installation.resolve({ managedOnly: true }).pipe(Effect.option);
    if (Option.isNone(installed))
      return {
        ...base,
        installed: false,
        models: [],
        message: "Set up Codex to get started.",
        auth: { status: "unknown" as const },
      };
    return yield* runtime("installed").pipe(
      Effect.flatMap((effective) =>
        checkCodexProviderStatus(effective.config, undefined, effective.environment).pipe(
          provideHost,
        ),
      ),
      Effect.map((draft) =>
        stamp({
          ...draft,
          version: draft.version ?? installed.value.version,
          setup,
          runtimePaths,
        }),
      ),
      Effect.catch((cause) =>
        Effect.succeed({
          ...base,
          installed: true,
          version: installed.value.version,
          status: "error" as const,
          models: [],
          message: cause.message,
        }),
      ),
      Effect.scoped,
    );
  });
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
    getSettings: host.settings.get,
    streamSettings: host.settings.changes,
    haveSettingsChanged: () => false,
    initialSnapshot: () => pending,
    checkProvider: check,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Could not prepare managed Codex for Home.",
          cause,
        }),
    ),
  );
  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    onUsageLimits: (update) => snapshot.applyUsageLimits(update),
    resolveRuntime,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Failed to build Codex orchestration adapter.",
          cause,
        }),
    ),
  );
  const textGeneration = yield* makeCodexTextGeneration(
    config,
    undefined,
    snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    resolveRuntime,
    {
      providerInstanceId: instanceId,
      ...(host.environmentId === undefined ? {} : { environmentId: host.environmentId }),
    },
  );
  const snapshotForCwd = (cwd: string) =>
    enabled
      ? Effect.gen(function* () {
          const effective = yield* resolveRuntime;
          const route = yield* HomeRoute.resolveCodexRouteContext({
            settings: effective.config,
            binaryPath: effective.config.binaryPath,
            home: effective.config.homePath,
            cwd,
            environment: effective.environment,
            configArgv: [],
          });
          const skills = yield* probeCodexSkillsForCwd({
            binaryPath: effective.config.binaryPath,
            homePath: effective.config.homePath,
            cwd,
            environment: route.execution.environment,
            route,
          });
          return { ...(yield* snapshot.getSnapshot), skills };
        }).pipe(
          Effect.scoped,
          provideHost,
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: `Failed to probe Codex skills for '${cwd}'`,
                cause,
              }),
          ),
        )
      : snapshot.getSnapshot;
  return {
    instanceId,
    driverKind: DRIVER,
    continuationIdentity,
    displayName,
    accentColor,
    enabled,
    snapshot,
    snapshotForCwd,
    orchestrationAdapter,
    textGeneration,
  } satisfies ProviderInstance;
});
