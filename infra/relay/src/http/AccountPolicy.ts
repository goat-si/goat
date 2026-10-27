export const ACCOUNT_ENDPOINT_POLICY = {
  createEnvironmentLinkChallenge: "guarded",
  linkEnvironment: "guarded",
  exchangeDpopAccessToken: "guarded",
  connectEnvironment: "guarded",
  getEnvironmentStatus: "guarded",
  registerDevice: "guarded",
  registerLiveActivity: "guarded",
  getAgentActivitySnapshot: "guarded",
  listEnvironments: "owner",
  listDevices: "owner",
  listDevicesV2: "owner",
  unlinkEnvironment: "owner",
  releaseEnvironmentTunnel: "owner",
  unregisterDevice: "owner",
  registerManagedEndpointRecovery: "guarded",
  recoverManagedEndpoint: "guarded",
  publishAgentActivity: "guarded",
  updateLinkPreferences: "guarded",
  wakeHeldHooks: "guarded",
} as const;

const policy: ReadonlyMap<string, "owner" | "guarded"> = new Map(
  Object.entries(ACCOUNT_ENDPOINT_POLICY),
);
export const isOwnerEndpoint = (name: string) => policy.get(name) === "owner";
