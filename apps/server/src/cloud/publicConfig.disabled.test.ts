import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("keeps public Connect configuration disabled even with complete runtime credentials", async () => {
  vi.stubEnv("GOAT_RELAY_URL", "https://relay.wp1.invalid");
  vi.stubEnv("GOAT_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsud3AxLmludmFsaWQk");
  vi.stubEnv("GOAT_CLERK_CLI_OAUTH_CLIENT_ID", "oauth_wp1_synthetic");
  vi.resetModules();
  expect((await import("./publicConfig.ts")).hasCloudPublicConfig).toBe(false);
});
