import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";

/**
 * Where macOS installs keep the CLI when PATH has none, tried after a bare
 * `tailscale` is not found. Standard CLI locations come first (the app's
 * optional launcher and Homebrew); the app bundle binary is the last resort.
 * https://tailscale.com/docs/reference/tailscale-cli (macOS)
 */
export const MacTailscaleFallbackPaths = Context.Reference<ReadonlyArray<string>>(
  "@goat/tailscale/MacTailscaleFallbackPaths",
  {
    defaultValue: () => [
      "/usr/local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ],
  },
);
