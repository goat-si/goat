import { msg } from "gt-react";
import {
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  type PreviewViewportSetting,
} from "@goat/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@goat/shared/previewViewport";

export const FILL_VALUE = "fill";
export const RESPONSIVE_VALUE = "responsive";

export const viewportSelectValue = (viewport: PreviewViewportSetting): string => {
  if (viewport._tag === "fill") return FILL_VALUE;
  if (
    viewport._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)
  ) {
    return viewport.presetId;
  }
  return RESPONSIVE_VALUE;
};

/** Inline options lack an items map; bare SelectValue would display the stored fill token. */
export const viewportSelectLabel = (viewport: PreviewViewportSetting): string => {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return msg("Fill panel");
  if (value === RESPONSIVE_VALUE) return msg("Responsive");
  return PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? msg("Responsive");
};

export const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION;

export const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
});
