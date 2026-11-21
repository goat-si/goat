import * as HostProcess from "@goat/shared/HostProcess";
import { ProviderDriverKind } from "@goat/contracts";
import { PiSettings } from "../settings.ts";
import { PI_PROFILE, type PiRuntimeProfile } from "./profile.ts";
import { makePiAdapterV2 } from "./adapter.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@goat/provider-core/server/adapterDriver";

export type PiAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const makePiAdapterV2Driver = (
  profile: PiRuntimeProfile,
  settingsSchema: Schema.Codec<PiSettings, unknown>,
): ProviderAdapterDriver<PiSettings, PiAdapterV2DriverEnv> => ({
  driverKind: ProviderDriverKind.make(profile.driver),
  configSchema: settingsSchema,
  defaultConfig: (): PiSettings => Schema.decodeSync(settingsSchema)({}),
  create: Effect.fn("PiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PiSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const home = yield* HostProcess.HomeDirectory;
      const currentEnvironment = Effect.suspend(() =>
        mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      ).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      return yield* makePiAdapterV2({
        instanceId: input.instanceId,
        profile,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* currentEnvironment,
        currentEnvironment,
        continuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ProviderDriverKind.make(profile.driver),
              instanceId: input.instanceId,
              detail: `Failed to create ${profile.displayName} adapter.`,
              cause,
            }),
        ),
      ),
  ),
});
export const PiAdapterV2Driver = makePiAdapterV2Driver(PI_PROFILE, PiSettings);
