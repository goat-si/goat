import type { ComposerCapabilityItem } from "@goat/client-runtime/composerCapabilityItems";
import type { EnvironmentId, ModelSelection, PreviewTabContextRecord } from "@goat/contracts";
import {
  appCapabilityContextRecord,
  turnCapabilityContextRecord,
} from "@goat/shared/turnCapabilities";

import { formatInlineContextReference } from "../../lib/composerContextReferences";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerTrigger } from "../../composer-logic";

export function compactSlashCommandAvailable(input: {
  trigger: ComposerTrigger | null;
  prompt: string;
  compactThreadUnavailable: boolean;
  attachmentCount: number;
  contextCount: number;
}): boolean {
  const { trigger, prompt } = input;
  return (
    trigger?.kind === "slash-command" &&
    prompt.slice(0, trigger.rangeStart).trim() === "" &&
    !input.compactThreadUnavailable &&
    prompt.slice(trigger.rangeEnd).trim() === "" &&
    input.attachmentCount === 0 &&
    input.contextCount === 0
  );
}

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
    const record =
      input.item.app === undefined
        ? turnCapabilityContextRecord(input.item.capability)
        : appCapabilityContextRecord(input.item.app);
    if (input.replaceTriggerWith(`${formatInlineContextReference(record)} `)) input.onReplaced();
    return;
  }
  if (availability.state !== "unavailable" || !availability.setup) return;
  if (input.replaceTriggerWith("")) input.onReplaced();
  input.openSetup();
}

export function selectComposerPreviewTab(input: {
  readonly record: PreviewTabContextRecord;
  readonly environmentId: EnvironmentId;
  readonly replaceTriggerWith: (replacement: string) => boolean;
  readonly addToDraft: (record: PreviewTabContextRecord) => void;
  readonly onReplaced: () => void;
}): void {
  if (input.record.environmentId !== input.environmentId) return;
  if (!input.replaceTriggerWith(`${formatInlineContextReference(input.record)} `)) return;
  input.addToDraft(input.record);
  input.onReplaced();
}
