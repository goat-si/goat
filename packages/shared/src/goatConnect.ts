/**
 * GOAT Connect will replace T3 Connect (Clerk sign-in plus the hosted relay). Until it ships,
 * the server and every client keep that stack off, even in builds that still carry Clerk or
 * relay public configuration, so a fresh install makes no Clerk or relay requests.
 */
const GOAT_CONNECT_ENABLED: boolean = false;

/** Read through this instead of the constant so tests can turn the feature on with a module mock. */
export function isGoatConnectEnabled(): boolean {
  return GOAT_CONNECT_ENABLED;
}

// Release artifacts must not link into the GOAT source repository (D-10), so the guide is
// Tailscale's own; `goat pair --tailscale` covers the GOAT side.
const GOAT_CONNECT_TAILSCALE_GUIDE_URL = "https://tailscale.com/kb/1153/enabling-https";

export const GOAT_CONNECT_COMING_SOON = {
  title: "GOAT Connect",
  status: "Coming soon",
  description: "Connect with Tailscale for now.",
  guideUrl: GOAT_CONNECT_TAILSCALE_GUIDE_URL,
} as const;

export const GOAT_CONNECT_CLI_COMING_SOON_MESSAGE =
  "GOAT Connect is coming soon. Use `goat pair --tailscale` to connect a device over Tailscale.";
