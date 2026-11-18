import { ANTIGRAVITY_DEFAULT_MODEL, type ProviderInstanceId } from "@goat/contracts";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

export function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    (input.entry.driverKind === "opencode" ||
      input.entry.driverKind === "antigravity" ||
      input.entry.driverKind === "cursor") &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}
