import { hasProviderSetup } from "./ProviderStatusBanner";
import type { ModelEsque } from "./providerIconUtils";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

export function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}
