import type { ComposerCapabilityItem } from "@goat/client-runtime/composerCapabilityItems";
import type { EnvironmentId, ModelSelection } from "@goat/contracts";
import { turnCapabilityContextRecord } from "@goat/shared/turnCapabilities";

import { formatInlineContextReference } from "../../lib/composerContextReferences";
import type { ProviderInstanceEntry } from "../../providerInstances";

/** The drivers a send goes to: every selected model when it fans out, else the one selected. */
export function composerCapabilityTargetDrivers(
  selections: ReadonlyArray<ModelSelection>,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): string[] {
  return selections.flatMap((selection) => {
    const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
    return entry === undefined ? [] : [entry.driverKind];
  });
}

/** Computer settings of the host this composer sends to, the one whose setup is missing. */
export const composerComputerSetupLocation = (environmentId: EnvironmentId) =>
  ({
    to: "/settings/integrations",
    search: { project: undefined, machine: environmentId, checkout: undefined },
    hash: "computer",
  }) as const;

/**
 * Picking `@computer` or `@browser`: an available one becomes a chip; one Settings can fix
 * opens them; one still checking, or that Settings cannot fix, keeps the typed text and its row
 * says why.
 */
export function selectComposerCapability(input: {
  readonly item: ComposerCapabilityItem;
  readonly replaceTriggerWith: (replacement: string) => boolean;
  readonly onReplaced: () => void;
  readonly openSetup: () => void;
}): void {
  const { availability } = input.item;
  if (availability.state === "available") {
    const record = turnCapabilityContextRecord(input.item.capability);
    if (input.replaceTriggerWith(`${formatInlineContextReference(record)} `)) input.onReplaced();
    return;
  }
  if (availability.state !== "unavailable" || !availability.setup) return;
  if (input.replaceTriggerWith("")) input.onReplaced();
  input.openSetup();
}
