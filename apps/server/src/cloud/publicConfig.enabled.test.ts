import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("retains complete configured public Connect credentials when enabled", async () => {
  vi.stubEnv("GOAT_RELAY_URL", "https://relay.wp1.invalid");
  vi.stubEnv("GOAT_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsud3AxLmludmFsaWQk");
  vi.stubEnv("GOAT_CLERK_CLI_OAUTH_CLIENT_ID", "oauth_wp1_synthetic");
  vi.resetModules();
  expect((await import("./publicConfig.ts")).hasCloudPublicConfig).toBe(true);
});

it("requires public credentials even when enabled", async () => {
  vi.stubEnv("GOAT_RELAY_URL", "");
  vi.stubEnv("GOAT_CLERK_PUBLISHABLE_KEY", "");
  vi.stubEnv("GOAT_CLERK_CLI_OAUTH_CLIENT_ID", "");
  vi.resetModules();
  expect((await import("./publicConfig.ts")).hasCloudPublicConfig).toBe(false);
});
