import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@goat/contracts";
import { createModelCapabilities } from "@goat/shared/model";
import type { ProviderDriver, ProviderInstance } from "@goat/provider-core/server/driver";
import { defaultProviderContinuationIdentity } from "@goat/provider-core/server/driver";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import { withInstanceIdentity } from "@goat/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import { buildServerProvider } from "@goat/provider-core/server/snapshotProbe";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CursorSdk from "../CursorSdk.ts";
import { buildCursorDiscoveredModelsFromSdk } from "../status.ts";
import { CursorCloudSettings } from "../../settings.ts";
import { makeCursorCloudCredentials } from "./credentials.ts";
import { DRIVER, makeCursorCloudAdapter } from "./adapter.ts";
import * as CursorCloudSdk from "./sdk.ts";

export type CursorCloudDriverEnv =
  | ProviderHost.ProviderHost
  | CursorSdk.CursorSdk
  | IdAllocator.IdAllocatorV2;
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});
const decode = Schema.decodeSync(CursorCloudSettings);
const fallbackModels: ServerProviderModel[] = [
  {
    slug: "auto",
    name: "Cursor account default",
    isCustom: false,
    isDefault: true,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  },
];

export const CursorCloudDriver: ProviderDriver<CursorCloudSettings, CursorCloudDriverEnv> = {
  driverKind: ProviderDriverKind.make("cursorCloud"),
  metadata: {
    displayName: "Cursor Cloud",
    supportsMultipleInstances: true,
    hasDefaultInstance: true,
  },
  configSchema: CursorCloudSettings,
  defaultConfig: () => decode({}),
  create: (input) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const sdk = yield* CursorCloudSdk.CursorCloudSdk;
      const credentials = yield* makeCursorCloudCredentials(
        input.instanceId,
        ProviderInstanceId.make(input.config.sourceInstanceId),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId: input.instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId: input.instanceId,
        driverKind: DRIVER,
        displayName: input.displayName ?? "Cursor Cloud",
        accentColor: input.accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const snapshotValue = (state: {
        status: "ready" | "warning" | "error";
        auth: "authenticated" | "unauthenticated" | "unknown";
        message?: string;
        models?: ReadonlyArray<ServerProviderModel>;
      }): Effect.Effect<ServerProvider> =>
        DateTime.now.pipe(
          Effect.map((now) => ({
            ...stamp(
              buildServerProvider({
                driver: DRIVER,
                enabled: input.enabled,
                checkedAt: DateTime.formatIso(now),
                presentation: {
                  displayName: "Cursor Cloud",
                  badgeLabel: "Cloud",
                  showInteractionModeToggle: false,
                  supportsConversationRollback: false,
                  supportedRuntimeModes: ["full-access"],
                },
                models: state.models ?? fallbackModels,
                probe: {
                  installed: true,
                  version: null,
                  status: state.status,
                  auth: { status: state.auth, canLogout: false },
                  ...(state.message ? { message: state.message } : {}),
                },
              }),
            ),
            executionLocation: "cloud" as const,
            authSourceInstanceId: ProviderInstanceId.make(input.config.sourceInstanceId),
            setup: { canAuthenticate: false, canInstall: false },
          })),
        );
      const checkProvider = input.enabled
        ? Effect.gen(function* () {
            const apiKey = yield* credentials.requireApiKey;
            yield* sdk.checkAccess(apiKey);
            const models = yield* sdk.readModels(apiKey);
            return yield* snapshotValue({
              status: "ready",
              auth: "authenticated",
              models: [
                ...fallbackModels,
                ...buildCursorDiscoveredModelsFromSdk(models).filter(
                  (model) => model.slug !== "auto",
                ),
              ],
            });
          }).pipe(
            Effect.timeout("15 seconds"),
            Effect.catch((cause) =>
              // No key at all means the Cursor sign-in is missing, not that access failed.
              Schema.is(ProviderSetupError)(cause) && cause.operation === "credentials"
                ? snapshotValue({
                    status: "error",
                    auth: "unauthenticated",
                    message: "Sign in to Cursor to use Cursor Cloud.",
                  })
                : snapshotValue({
                    status: "error",
                    auth: "unknown",
                    message:
                      "Cursor Cloud access is unavailable. Check the selected Cursor sign-in and cloud account access.",
                  }),
            ),
          )
        : snapshotValue({
            status: "warning",
            auth: "unknown",
            message: "Cursor Cloud is disabled.",
          });
      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: host.settings.get,
        streamSettings: host.settings.changes,
        haveSettingsChanged: (before, after) => before !== after,
        initialSnapshot: () =>
          snapshotValue({
            status: "warning",
            auth: "unknown",
            message: "Checking Cursor Cloud access...",
          }),
        checkProvider,
      });
      const orchestrationAdapter = yield* makeCursorCloudAdapter(
        input.instanceId,
        credentials.requireApiKey,
      );
      const unsupported = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Choose a local text-generation provider for this operation.",
          }),
        );
      return {
        instanceId: input.instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        snapshot,
        orchestrationAdapter,
        auth: credentials.auth,
        textGeneration: {
          generateCommitMessage: () => unsupported("generateCommitMessage"),
          generatePrContent: () => unsupported("generatePrContent"),
          generateBranchName: () => unsupported("generateBranchName"),
          generateReviewGuide: () => unsupported("generateReviewGuide"),
          generateThreadTitle: ({ message }) =>
            Effect.succeed({ title: message.trim().slice(0, 100) || "Cursor Cloud" }),
        },
      } satisfies ProviderInstance;
    }).pipe(
      Effect.provide(CursorCloudSdk.layer),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Could not initialize Cursor Cloud.",
            cause,
          }),
      ),
    ),
};
