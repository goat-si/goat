import { t } from "gt-react";
import { isPreviewUrlNormalizationError } from "@goat/shared/preview";
import { toastManager } from "../ui/toast";
export function reportPreviewAddressError(error: unknown) {
  toastManager.add({
    type: "error",
    title: t("Could not open this address"),
    description: isPreviewUrlNormalizationError(error)
      ? t("Enter an http or https URL.")
      : error instanceof Error
        ? error.message
        : t("An error occurred."),
  });
}
