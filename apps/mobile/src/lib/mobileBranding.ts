import type { BrandChannel } from "@goat/shared/brandChannels";

export function resolveMobileBrandChannel(appVariant: unknown): BrandChannel {
  if (appVariant === "development") return "dev";
  if (appVariant === "preview") return "nightly";
  return "stable";
}
