import type { ProviderInstanceEnvironment } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { isMiniMaxCode, type AcpRegistrySettings } from "../settings.ts";
import { environmentText } from "./environmentCheck.ts";
import { makeMiniMaxCodeQuotaReader } from "./minimaxCodeAccountQuota.ts";

function hasExplicitMiniMaxQuotaProfile(environment: ProviderInstanceEnvironment | undefined) {
  if (!environment) return false;
  const dataDirectories = environment.filter(({ name }) => name === "MINIMAX_DATA_DIR");
  const regions = environment.filter(({ name }) => name === "MAVIS_REGION");
  const safeLiteral = (variable: ProviderInstanceEnvironment[number]) =>
    !variable.sensitive &&
    variable.secret === undefined &&
    !variable.valueRedacted &&
    variable.value.trim() !== "" &&
    variable.value.trim() === variable.value;
  const directory = dataDirectories[0];
  if (
    dataDirectories.length !== 1 ||
    !directory ||
    !safeLiteral(directory) ||
    !directory.value.startsWith("/")
  )
    return false;
  // An inherited launch region or MCode's own preference may select the region
  // inside this explicit profile; do not accept ambiguous provider overrides.
  const region = regions[0];
  return (
    regions.length === 0 ||
    (regions.length === 1 &&
      region !== undefined &&
      safeLiteral(region) &&
      (region.value === "en" || region.value === "cn"))
  );
}

export const makeMiniMaxCodeUsageEnrichment = Effect.fnUntraced(function* (
  settings: AcpRegistrySettings,
  environment: ProviderInstanceEnvironment | undefined,
  currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>,
) {
  if (
    !settings.enabled ||
    !settings.readMiniMaxCodeQuota ||
    !isMiniMaxCode(settings) ||
    !hasExplicitMiniMaxQuotaProfile(environment)
  )
    return {};
  const readQuota = yield* makeMiniMaxCodeQuotaReader();
  return {
    enrichUsageLimits: Effect.fn("AcpRegistryDriver.enrichMiniMaxCodeQuota")(function* () {
      const environment = yield* currentEnvironment;
      const usage = yield* readQuota(environment, settings.commandArgs);
      return environmentText(environment) === environmentText(yield* currentEnvironment)
        ? usage
        : undefined;
    }),
  };
});
