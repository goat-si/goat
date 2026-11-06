import type { ProviderLocalPreset } from "@goat/contracts";

export function localPresetDraft(preset: ProviderLocalPreset) {
  return {
    label: preset.label,
    config: { source: "local", commandPath: preset.command, commandArgs: [...preset.args] },
  };
}
