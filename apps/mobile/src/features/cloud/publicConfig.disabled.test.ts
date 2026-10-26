import { describe, expect, it, vi } from "vite-plus/test";
import {
  hasCloudPublicConfig,
  hasTracingPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "relay" },
        relay: { url: "https://relay.example.test" },
        observability: {
          tracesUrl: "https://traces.example.test",
          tracesDataset: "mobile",
          tracesToken: "ingest",
        },
      },
    },
  },
}));

describe("default-off mobile public config", () => {
  it("masks injected authentication, relay and product tracing config", () => {
    expect(resolveCloudPublicConfig()).toEqual({
      clerk: { publishableKey: null, jwtTemplate: null },
      relay: { url: null },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
    expect(hasCloudPublicConfig()).toBe(false);
    expect(hasTracingPublicConfig()).toBe(false);
    expect(() => resolveRelayClerkTokenOptions()).toThrow(
      "GOAT_CLERK_JWT_TEMPLATE is not configured.",
    );
  });
});
