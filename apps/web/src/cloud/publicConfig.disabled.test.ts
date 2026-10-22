import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CloudPublicConfigMissingError,
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
  resolveRelayTracingConfig,
} from "./publicConfig";
import { buildConnectCliClerkAuthorizeUrl, connectCliAuthRoutesEnabled } from "./connectCliAuth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GOAT Connect disabled with complete public configuration", () => {
  it("discards Clerk, relay, and tracing configuration without requests", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("configured.clerk.accounts.dev$")}`);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://traces.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "trace-token");
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(resolveCloudPublicConfig()).toEqual({
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      relayUrl: null,
      relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
    expect(hasCloudPublicConfig()).toBe(false);
    expect(resolveRelayTracingConfig()).toBeNull();
    expect(() => resolveRelayClerkTokenOptions()).toThrowError(CloudPublicConfigMissingError);
    expect(connectCliAuthRoutesEnabled()).toBe(false);
    expect(
      buildConnectCliClerkAuthorizeUrl({
        state: "state",
        challenge: "challenge",
        loopbackPort: 34338,
      }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
