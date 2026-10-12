import {
  environmentSupportsChannelLedger,
  type GoatBotEnvironmentInput,
} from "@t3tools/client-runtime/goatBot";

import type { EnvironmentPresentation } from "../../state/environments";

/** Mobile has no primary machine; runtime labels take precedence over saved labels. */
export function mobileGoatBotEnvironmentInput(
  entry: Pick<EnvironmentPresentation, "environmentId" | "label"> & {
    readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
    readonly serverConfig: {
      readonly environment: Pick<
        NonNullable<EnvironmentPresentation["serverConfig"]>["environment"],
        "label" | "capabilities"
      >;
      readonly settings?: Pick<
        NonNullable<EnvironmentPresentation["serverConfig"]>["settings"],
        "goatBotHome"
      >;
    } | null;
  },
): GoatBotEnvironmentInput {
  const connected = entry.connection.phase === "connected";
  const supportsBot = environmentSupportsChannelLedger(
    entry.serverConfig?.environment.capabilities,
  );
  const settings = entry.serverConfig?.settings ?? null;
  return {
    environmentId: entry.environmentId,
    connected,
    primary: false,
    label:
      entry.serverConfig?.environment.label?.trim() || entry.label.trim() || entry.environmentId,
    supportsChannelLedger: supportsBot,
    settingsSnapshot: settings,
    homeTarget: {
      environmentId: entry.environmentId,
      connected,
      supportsHome: entry.serverConfig?.environment.capabilities.goatBotHome === true,
      supportsBot,
      settingsLoaded: settings !== null,
      home: settings?.goatBotHome ?? null,
    },
  };
}
