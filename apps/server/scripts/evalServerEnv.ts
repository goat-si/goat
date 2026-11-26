/** A fixture server's environment. GOAT_HOME outranks the bootstrap home, so an inherited one could reach real state. */
export const evalServerEnv = (base: NodeJS.ProcessEnv, goatHome: string): NodeJS.ProcessEnv => ({
  ...base,
  GOAT_HOME: goatHome,
  GOAT_TELEMETRY_ENABLED: "false",
});
