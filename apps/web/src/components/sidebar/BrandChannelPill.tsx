import { BRAND_CHANNEL_LABEL, type BrandChannel } from "@goat/shared/brandChannels";

import { cn } from "../../lib/utils";

export function BrandChannelPill({ channel }: { channel: BrandChannel }) {
  if (channel === "stable") return null;
  return (
    <span
      data-environment-identification="pill"
      className={cn(
        "inline-flex h-5 items-center rounded-full px-1.5 text-2xs font-medium",
        channel === "dev"
          ? "bg-channel-dev/10 text-channel-dev"
          : "bg-channel-nightly/10 text-channel-nightly",
      )}
    >
      {BRAND_CHANNEL_LABEL[channel]}
    </span>
  );
}
