import {
  environmentSupportsChannelLedger,
  type GoatBotEnvironmentInput,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";

import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import type { EnvironmentPresentation } from "~/state/environments";
import type { GoatBotRefusal } from "./useGoatBotComputerReadable";

/** Every machine as GOAT Bot sees it, for the hook, the answer-time read and the Home atom. */
export function goatBotEnvironmentInputs(
  environments: ReadonlyArray<EnvironmentPresentation>,
  primaryEnvironmentId: EnvironmentId | null,
  /** Only the hook passes refusals; picking a computer never depends on them. */
  refused?: ReadonlyMap<EnvironmentId, GoatBotRefusal>,
): ReadonlyArray<GoatBotEnvironmentInput> {
  return environments.map((entry) => ({
    environmentId: entry.environmentId,
    connected: entry.connection.phase === "connected",
    supportsChannelLedger: environmentSupportsChannelLedger(
      entry.serverConfig?.environment.capabilities,
    ),
    supportsBotStatus: entry.serverConfig?.environment.capabilities.goatBotStatus === true,
    primary: entry.environmentId === primaryEnvironmentId,
    label: resolveEnvironmentOptionLabel({
      isPrimary: entry.environmentId === primaryEnvironmentId,
      environmentId: entry.environmentId,
      runtimeLabel: entry.serverConfig?.environment.label ?? null,
      savedLabel: entry.label,
    }),
    settingsSnapshot: entry.serverConfig?.settings ?? null,
    homeTarget: {
      environmentId: entry.environmentId,
      connected: entry.connection.phase === "connected",
      supportsHome: entry.serverConfig?.environment.capabilities.goatBotHome === true,
      supportsBot: environmentSupportsChannelLedger(entry.serverConfig?.environment.capabilities),
      settingsLoaded: entry.serverConfig?.settings != null,
      home: entry.serverConfig?.settings?.goatBotHome ?? null,
    },
    ...(refused?.has(entry.environmentId) ? { refused: true } : {}),
    ...(refused?.get(entry.environmentId) === "session-ended" ? { sessionEnded: true } : {}),
  }));
}
