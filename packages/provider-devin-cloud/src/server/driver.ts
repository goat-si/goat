import {
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type ServerProvider,
} from "@goat/contracts";
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import { DEVIN_MODELS, DevinCloudSettings } from "../settings.ts";
import * as Cli from "./cli.ts";
import * as Relay from "./relay.ts";
import { makeAdapter } from "./adapter.ts";

export type DevinCloudDriverEnv =
  | ProviderHost.ProviderHost
  | AcpRegistrySupport.AcpRegistryCatalog
  | ChildProcessSpawner.ChildProcessSpawner;
const DRIVER = ProviderDriverKind.make("devinCloud");
const decodeSettings = Schema.decodeSync(DevinCloudSettings);
const modelCapabilities = {
  optionDescriptors: [
    {
      id: "platform",
      label: "Platform",
      type: "select",
      currentValue: "default",
      options: [
        { id: "default", label: "Account default", isDefault: true },
        { id: "linux", label: "Ubuntu" },
        { id: "macos", label: "macOS" },
        { id: "windows", label: "Windows" },
      ],
    },
  ],
} as const;
export const DevinCloudDriver: ProviderDriver<DevinCloudSettings, DevinCloudDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "Devin Cloud",
    supportsMultipleInstances: true,
    hasDefaultInstance: true,
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
      const configuredSource = Schema.decodeOption(ProviderInstanceId)(
        input.config.siblingInstanceId,
      );
      return {
        instanceId: input.instanceId,
        driver: DRIVER,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: input.enabled,
        ...(Option.isSome(configuredSource)
          ? { authSourceInstanceId: configuredSource.value }
          : {}),
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
        models: DEVIN_MODELS.map(([slug, name]) => ({
          slug,
          name,
          isCustom: false,
          isDefault: slug === "default",
          capabilities: modelCapabilities,
        })),
        message: "Uses your Devin sign-in. Repository access is checked by the cloud task.",
      } satisfies ServerProvider;
    });
    const check = Effect.gen(function* () {
      const snapshot = yield* initial();
      if (!input.enabled) return snapshot;
      let sourceInstanceId = snapshot.authSourceInstanceId;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const launch = yield* cli.resolve(input.config.siblingInstanceId, host.paths.cwd);
          sourceInstanceId = launch.sourceInstanceId;
          const readiness = yield* cli.probe(launch);
          return { ...readiness, sourceInstanceId: launch.sourceInstanceId };
        }),
      );
      if (Result.isFailure(result)) {
        if (!sourceInstanceId) {
          const settings = yield* Effect.option(host.settings.get);
          if (Option.isSome(settings))
            sourceInstanceId = Cli.selectSiblingInstanceId(
              settings.value,
              input.config.siblingInstanceId,
            ).id;
        }
        return {
          ...snapshot,
          ...(sourceInstanceId ? { authSourceInstanceId: sourceInstanceId } : {}),
          status: "error" as const,
          ...(result.failure.stage === "auth"
            ? { installed: true, auth: { status: "unauthenticated" as const } }
            : {}),
          message: result.failure.message,
        };
      }
      return {
        ...snapshot,
        installed: true,
        version: result.success.version,
        authSourceInstanceId: result.success.sourceInstanceId,
        status: "ready" as const,
        auth: {
          status: "authenticated" as const,
          ...(result.success.email ? { email: result.success.email } : {}),
        },
        message: "Repository access and quota are checked per task.",
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
