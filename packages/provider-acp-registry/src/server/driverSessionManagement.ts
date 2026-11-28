import type { ProviderInstanceId } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  deleteAcpRegistrySession,
  disableAcpRegistryProvider,
  listAcpRegistryProviders,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  setAcpRegistryProvider,
} from "./probe.ts";

export function makeAcpRegistrySessionManagement(deps: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>;
  readonly catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"];
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly digest: Digest.Digest["Service"];
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly runtimeCoordinator: Option.Option<
    AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"]
  >;
  readonly onProviderMutation: Effect.Effect<void>;
  readonly onLogout: (environment: NodeJS.ProcessEnv) => Effect.Effect<void>;
  readonly onAfterLogout: Effect.Effect<void>;
}): NonNullable<ProviderInstance["acpSessionManagement"]> {
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | AcpRegistrySupport.AcpRegistryCatalog
      | ChildProcessSpawner.ChildProcessSpawner
      | SecureRandom.SecureRandom
    >,
  ): Effect.Effect<A, E> => {
    const provided = effect.pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, deps.catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.spawner),
      Effect.provideService(Digest.Digest, deps.digest),
      Effect.provideService(SecureRandom.SecureRandom, deps.random),
    );
    return Option.isSome(deps.runtimeCoordinator)
      ? provided.pipe(
          Effect.provideService(
            AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
            deps.runtimeCoordinator.value,
          ),
        )
      : provided;
  };
  const withEnv = <A, E>(
    run: (
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<
      A,
      E,
      | AcpRegistrySupport.AcpRegistryCatalog
      | ChildProcessSpawner.ChildProcessSpawner
      | SecureRandom.SecureRandom
    >,
  ) => provide(deps.currentEnvironment.pipe(Effect.flatMap(run)));

  return {
    listSessions: ({ cwd, cursor }) =>
      withEnv((environment) =>
        listAcpRegistrySessions({
          instanceId: deps.instanceId,
          settings: deps.settings,
          cwd,
          environment,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
    deleteSession: ({ cwd, sessionId }) =>
      withEnv((environment) =>
        deleteAcpRegistrySession({
          instanceId: deps.instanceId,
          settings: deps.settings,
          cwd,
          environment,
          sessionId,
        }),
      ),
    listProviders: (cwd) =>
      withEnv((environment) =>
        listAcpRegistryProviders({
          instanceId: deps.instanceId,
          settings: deps.settings,
          cwd,
          environment,
        }),
      ),
    setProvider: ({ cwd, providerId, apiType, baseUrl, headers }) =>
      withEnv((environment) =>
        setAcpRegistryProvider({
          instanceId: deps.instanceId,
          settings: deps.settings,
          cwd,
          environment,
          providerId,
          apiType,
          baseUrl,
          ...(headers === undefined ? {} : { headers }),
        }),
      ).pipe(Effect.tap(() => deps.onProviderMutation)),
    disableProvider: ({ cwd, providerId }) =>
      withEnv((environment) =>
        disableAcpRegistryProvider({
          instanceId: deps.instanceId,
          settings: deps.settings,
          cwd,
          environment,
          providerId,
        }),
      ).pipe(Effect.tap(() => deps.onProviderMutation)),
    logout: (cwd) =>
      withEnv((environment) =>
        logoutAcpRegistry({
          instanceId: deps.instanceId,
          settings: deps.settings,
          cwd,
          environment,
        }).pipe(Effect.andThen(deps.onLogout(environment))),
      ).pipe(Effect.tap(() => deps.onAfterLogout)),
  };
}
