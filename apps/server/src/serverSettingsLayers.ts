import * as Layer from "effect/Layer";
import * as Settings from "./serverSettings.ts";

export const settingsLayers = (
  service: Settings.ServerSettingsService["Service"] &
    Settings.MemoryHubSettingsTransitions["Service"] & {
      adminSettings: Settings.MemoryHubAdminSettings["Service"];
      committedHubSettings: Settings.MemoryHubCommittedSettings["Service"];
      committedProviderPolicy: Settings.MemoryProviderCommittedPolicy["Service"];
      committedOwnerPolicy: Settings.MemoryOwnerSourceReadCommittedPolicy["Service"];
      ownerPolicyAdministration: Settings.MemoryOwnerSourceReadPolicyAdministration["Service"];
    },
) =>
  Layer.mergeAll(
    Layer.succeed(Settings.ServerSettingsService, service),
    Layer.succeed(Settings.MemoryHubCommittedSettings, service.committedHubSettings),
    Layer.succeed(Settings.MemoryProviderCommittedPolicy, service.committedProviderPolicy),
    Layer.succeed(Settings.MemoryOwnerSourceReadCommittedPolicy, service.committedOwnerPolicy),
    Layer.succeed(
      Settings.MemoryOwnerSourceReadPolicyAdministration,
      service.ownerPolicyAdministration,
    ),
    Layer.succeed(Settings.MemoryHubAdminSettings, service.adminSettings),
    Layer.succeed(Settings.MemoryHubSettingsTransitions, {
      applyMemoryHubTransition: service.applyMemoryHubTransition,
    }),
  );
