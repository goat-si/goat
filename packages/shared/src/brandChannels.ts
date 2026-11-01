export type BrandChannel = "stable" | "nightly" | "dev";
/** Flat app-icon backgrounds per release channel. */
export const BRAND_CHANNEL_ICON_BACKGROUND: Record<BrandChannel, string> = {
  stable: "#18181b",
  nightly: "#1e1b4b",
  dev: "#1d4ed8",
};
/** Channel badge text; stable shows no badge. */
export const BRAND_CHANNEL_LABEL: Record<BrandChannel, string | null> = {
  stable: null,
  nightly: "Nightly",
  dev: "Dev",
};
