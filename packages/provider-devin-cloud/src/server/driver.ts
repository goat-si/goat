import { ProviderDriverKind, TextGenerationError, type ServerProvider } from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
} from "@goat/provider-core/server/driver";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import type { ProviderTextGeneration } from "@goat/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import { DevinCloudSettings } from "../settings.ts";
import * as Cli from "./cli.ts";
import * as Relay from "./relay.ts";
import { makeAdapter } from "./adapter.ts";

export type DevinCloudDriverEnv =
  | ProviderHost.ProviderHost
  | AcpRegistrySupport.AcpRegistryCatalog
  | ChildProcessSpawner.ChildProcessSpawner;
const DRIVER = ProviderDriverKind.make("devinCloud");
const decodeSettings = Schema.decodeSync(DevinCloudSettings);
export const DevinCloudDriver: ProviderDriver<DevinCloudSettings, DevinCloudDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Devin Cloud",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: DevinCloudSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("DevinCloudDriver.create")(function* (
    input: ProviderDriverCreateInput<DevinCloudSettings>,
  ) {
    const host = yield* ProviderHost.ProviderHost;
    const services = yield* Layer.build(Layer.merge(Cli.layer, Relay.layer));
    const cli = yield* Effect.service(Cli.DevinCloudCli).pipe(Effect.provide(services));
    const orchestrationAdapter = yield* makeAdapter(
      input.instanceId,
      input.config.siblingInstanceId,
    ).pipe(Effect.provide(services));
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId: input.instanceId,
    });
    const maintenance = Effect.succeed({ provider: DRIVER, packageName: null, update: null });
    const initial = Effect.fn("DevinCloud.initial")(function* () {
      return {
        instanceId: input.instanceId,
        driver: DRIVER,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: input.enabled,
        installed: false,
        version: null,
        status: input.enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        executionLocation: "cloud",
        badgeLabel: "Cloud",
        supportsTextGeneration: false,
        supportsConversationRollback: false,
        supportedRuntimeModes: ["full-access"],
        showInteractionModeToggle: false,
        requiresNewThreadForModelChange: true,
        continuation: { groupKey: continuationIdentity.continuationKey },
        setup: {
          canAuthenticate: false,
          canInstall: false,
          documentationUrl: "https://docs.devin.ai/cli/cloud",
        },
        slashCommands: [],
        skills: [],
        models: [
          {
            slug: "default",
            name: "Cloud account default",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        message:
          "Uses the selected Devin ACP instance's CLI login and cloud account permissions. Repository access is checked by the cloud task.",
      } satisfies ServerProvider;
    });
    const check = Effect.gen(function* () {
      const snapshot = yield* initial();
      if (!input.enabled) return snapshot;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const launch = yield* cli.resolve(input.config.siblingInstanceId, host.paths.cwd);
          return yield* cli.probe(launch);
        }),
      );
      return Result.isFailure(result)
        ? { ...snapshot, status: "error" as const, message: result.failure.message }
        : {
            ...snapshot,
            installed: true,
            version: result.success,
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            message: "CLI signed in; cloud repository access and quota may still block a task.",
          };
    });
    const snapshot = yield* makeManagedServerProvider({
      resolveMaintenance: () => maintenance,
      getSettings: host.settings.get,
      streamSettings: host.settings.changes,
      // Sibling config/profile changes must invalidate readiness even if cloud config stays the same.
      haveSettingsChanged: (previous, next) => previous !== next,
      initialSnapshot: () => initial(),
      checkProvider: check,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Failed to build Devin Cloud readiness.",
            cause,
          }),
      ),
    );
    const unsupported = (operation: string) =>
      Effect.fail(
        new TextGenerationError({
          operation,
          detail: "Devin Cloud does not provide app-owned text generation.",
        }),
      );
    const textGeneration: ProviderTextGeneration = {
      generateCommitMessage: () => unsupported("generateCommitMessage"),
      generatePrContent: () => unsupported("generatePrContent"),
      generateBranchName: () => unsupported("generateBranchName"),
      generateThreadTitle: () => unsupported("generateThreadTitle"),
      generateReviewGuide: () => unsupported("generateReviewGuide"),
    };
    return {
      instanceId: input.instanceId,
      driverKind: DRIVER,
      enabled: input.enabled,
      displayName: input.displayName,
      accentColor: input.accentColor,
      continuationIdentity,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    };
  }),
};
