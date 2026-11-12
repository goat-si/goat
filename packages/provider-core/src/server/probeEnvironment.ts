import { overlayEnvironment } from "@goat/shared/environmentOverlay";

/** Keep automatic installs out of background provider probes. */
export function providerProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A view: drivers build this once, and their later probes must see the current PATH.
  return overlayEnvironment(environment, {
    MISE_OFFLINE: "1",
    MISE_AUTO_INSTALL: "0",
    MISE_NOT_FOUND_AUTO_INSTALL: "0",
    npm_config_offline: "true",
    NPM_CONFIG_OFFLINE: "true",
    UV_OFFLINE: "1",
    COREPACK_ENABLE_NETWORK: "0",
  });
}
