import { isPreviewUrlNormalizationError } from "@goat/shared/preview";
import { toastManager } from "../ui/toast";
export function reportPreviewAddressError(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Could not open this address",
    description: isPreviewUrlNormalizationError(error)
      ? "Enter an http or https URL."
      : error instanceof Error
        ? error.message
        : "An error occurred.",
  });
}
