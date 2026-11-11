/** Keep automatic installs out of background provider probes. */
export function providerProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    MISE_OFFLINE: "1",
    npm_config_offline: "true",
    NPM_CONFIG_OFFLINE: "true",
    UV_OFFLINE: "1",
    COREPACK_ENABLE_NETWORK: "0",
  };
}
