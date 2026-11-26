import type { ChildSetupText } from "@goat/client-runtime/hub-devices";
import { useGT } from "gt-react";

export function useHubChildSetupText(): ChildSetupText {
  const gt = useGT();
  return {
    reasons: {
      home_unavailable: gt("the hub's OpenCodex cannot install it"),
      platform_unsupported: gt("platform not supported"),
      goat_runtime_missing: gt(
        "GOAT isn't installed there yet; GOAT installs it first, then retries",
      ),
      npm_missing: gt("npm missing"),
      install_failed: gt("install failed"),
      ocx_unusable: gt("OpenCodex does not run there"),
      runtime_unhealthy: gt("OpenCodex not answering"),
      unreachable: gt("machine unreachable"),
      link_failed: gt("link failed"),
      consent_revoked: gt("turned off because the session that allowed it lost access"),
      setup_step_timeout: gt("A setup step timed out. Retry setup."),
    },
    states: {
      running: gt("Setting up as OpenCodex Child"),
      child: gt("Linked · Codex not verified"),
      degraded: gt("OpenCodex Child degraded"),
      blocked: gt("OpenCodex Child setup blocked"),
    },
    steps: {
      goat_available: gt("Prepare GOAT"),
      opencodex_running: gt("Start OpenCodex"),
      link_established: gt("Link to Home"),
      codex_installed: gt("Install Codex"),
      instance_routed: gt("Route Codex through Home"),
      inference_verified: gt("Verify a request through Home"),
    },
    actions: {
      none: null,
      continue_setup: gt("Continue setup"),
      retry: gt("Continue setup"),
      reconnect_home: gt("Repair link"),
      review_settings: gt("Review this Child's provider settings, then refresh status."),
      update_goat: gt("Update GOAT on Home and this Child, then refresh status."),
    },
    ready: gt("Ready"),
    unavailable: gt("Setup status unavailable. Refresh status."),
    withReason: (state, reason) => gt("{state}: {reason}", { state, reason }),
  };
}
