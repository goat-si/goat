import { gtFallback, type useGT } from "gt-react";
import type { ModelSelection, ProjectId, ServerProvider } from "@goat/contracts";
import type { UnifiedSettings } from "@goat/contracts/settings";

import {
  resolveEffectiveDefaultModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../../modelSelection";
import {
  resolveDefaultProviderModelSelection,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export interface DefaultModelSettingsPresentation {
  readonly selection: ModelSelection | null;
  /** Set when the saved model's provider cannot run; effort stays hidden until it can. */
  readonly providerNote: string | null;
}

export function resolveDefaultModelSettingsPresentation(
  input: {
    readonly entries: ReadonlyArray<ProviderInstanceEntry>;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly settings: UnifiedSettings;
    readonly projectId: ProjectId | null;
  },
  gt: ReturnType<typeof useGT> = gtFallback,
): DefaultModelSettingsPresentation {
  const saved = input.settings.defaultModelSelection;
  if (saved === null) {
    const automatic = resolveProjectDefaultProviderModelSelection(
      input.providers,
      input.settings,
      input.projectId,
    );
    return {
      selection: automatic
        ? resolveEffectiveDefaultModelSelection(input.settings, input.providers, automatic)
        : null,
      providerNote: null,
    };
  }

  const savedEntry = input.entries.find((entry) => entry.instanceId === saved.instanceId);
  const resolved = resolveDefaultProviderModelSelection(input.providers, saved);
  // Settings can turn a provider off before the server snapshot catches up, so check both.
  if (
    !savedEntry?.enabled ||
    !savedEntry.isAvailable ||
    resolved?.instanceId !== saved.instanceId
  ) {
    return { selection: saved, providerNote: providerNote(savedEntry, gt) };
  }
  return {
    selection: resolveEffectiveDefaultModelSelection(input.settings, input.providers, resolved),
    providerNote: null,
  };
}

function providerNote(
  entry: ProviderInstanceEntry | undefined,
  gt: ReturnType<typeof useGT>,
): string {
  if (!entry) return gt("This provider is not available on this environment.");
  if (!entry.enabled) return gt("{provider} is turned off.", { provider: entry.displayName });
  return gt("{provider} is unavailable.", { provider: entry.displayName });
}
