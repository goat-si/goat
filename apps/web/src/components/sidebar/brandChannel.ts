import { useAtomValue } from "@effect/atom-react";
import { BRAND_CHANNEL_LABEL, type BrandChannel } from "@goat/shared/brandChannels";

import { APP_STAGE_LABEL } from "../../branding";
import { resolveServerBackedAppStageLabel } from "../../branding.logic";
import { primaryServerConfigAtom } from "../../state/server";

export function resolveBrandChannel(stageLabel: string | null | undefined): BrandChannel {
  const normalized = stageLabel?.trim().toLowerCase();
  if (normalized === "dev") return "dev";
  if (normalized === "nightly") return "nightly";
  return "stable";
}

export function resolveEnvironmentIdentificationPillLabel(stageLabel: string | null | undefined) {
  return BRAND_CHANNEL_LABEL[resolveBrandChannel(stageLabel)];
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useBrandChannel(): BrandChannel {
  return resolveBrandChannel(useEnvironmentStageLabel());
}
