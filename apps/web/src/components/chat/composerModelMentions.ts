import { rankComposerModelMentions } from "@goat/client-runtime/composer-model-mentions";
import type { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";
import { formatComposerModelMention } from "@goat/client-runtime/composer-model-mentions";
import { serializeComposerFileLink } from "@goat/shared/composerTrigger";
import type { ComposerTrigger } from "../../composer-logic";
import { isPathSuggestionCurrent } from "../../composer-logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import type { EnvironmentId } from "@goat/contracts";

export interface ComposerModelItem {
  readonly id: string;
  readonly type: "model";
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  readonly description: string;
}

export function composerPathOrModelReplacement(
  item: Extract<ComposerCommandItem, { type: "path" | "model" }>,
  trigger: ComposerTrigger,
  environmentId: EnvironmentId,
  cwd: string | null,
): string | null {
  if (item.type === "model")
    return trigger.kind === "path"
      ? `${formatComposerModelMention(item.instanceId, item.model)} `
      : null;
  return isPathSuggestionCurrent(item.searchTarget, trigger, environmentId, cwd)
    ? `${serializeComposerFileLink(item.path)} `
    : null;
}

export function matchComposerModelItems(input: {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly query: string;
}): ComposerModelItem[] {
  const candidates: Array<{ entry: ProviderInstanceEntry; option: ModelEsque }> = [];
  for (const entry of input.instanceEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    for (const option of input.modelOptionsByInstance.get(entry.instanceId) ?? []) {
      if (!option.isLegacy && !option.isUnavailable) candidates.push({ entry, option });
    }
  }
  return rankComposerModelMentions(candidates, input.query, ({ entry, option }) => ({
    name: option.name,
    ...(option.shortName ? { shortName: option.shortName } : {}),
    ...(option.subProvider ? { subProvider: option.subProvider } : {}),
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
  })).map(({ entry, option }) => ({
    id: `model:${entry.instanceId}:${option.slug}`,
    type: "model",
    instanceId: entry.instanceId,
    model: option.slug,
    driverKind: entry.driverKind,
    label: getDisplayModelName(option),
    description: option.subProvider ?? entry.displayName,
  }));
}
