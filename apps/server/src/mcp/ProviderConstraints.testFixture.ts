import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as ServerSettings from "../serverSettings.ts";

export const capabilitySettingsLayer = () =>
  ServerSettings.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("pi")]: { driver: ProviderDriverKind.make("pi"), enabled: true },
      [ProviderInstanceId.make("acpRegistry")]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
      },
      [ProviderInstanceId.make("antigravity")]: {
        driver: ProviderDriverKind.make("antigravity"),
        enabled: true,
      },
    },
  });
