import type { PreviewViewportSetting } from "@goat/contracts";

export const viewportSettingsEqual = (
  left: PreviewViewportSetting,
  right: PreviewViewportSetting,
) =>
  left._tag === right._tag &&
  (left._tag === "fill" ||
    (right._tag !== "fill" && left.width === right.width && left.height === right.height));

export const fixedViewportSize = (setting: PreviewViewportSetting) =>
  setting._tag === "fill" ? null : { width: setting.width, height: setting.height };
