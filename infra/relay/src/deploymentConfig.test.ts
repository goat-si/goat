import { describe, expect, it } from "vite-plus/test";

import {
  managedEndpointHostname,
  managedEndpointDigestInput,
  isManagedEndpointHostname,
  relayOwnsManagedEndpointZone,
} from "./deploymentConfig.ts";

describe("relayOwnsManagedEndpointZone", () => {
  it("keeps the shared Cloudflare zone owned by production", () => {
    expect(relayOwnsManagedEndpointZone("prod")).toBe(true);
    expect(relayOwnsManagedEndpointZone("dev_alex")).toBe(false);
  });
});

describe("managed endpoint names", () => {
  it("keeps the DNS label within the provider limit for long stage names", () => {
    const hostname = managedEndpointHostname(
      "dev_" + "x".repeat(100),
      "example.com",
      "a".repeat(64),
    );

    expect(hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/-a{16}\.example\.com$/);
  });

  it("rejects hostnames outside the relay zone", () => {
    expect(isManagedEndpointHostname("internal.example.net", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("example.com.attacker.test", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("dev-alex.example.com.", "example.com")).toBe(false);
  });
});

it("generation zero preserves the exact digest input while retired generations are never selected again", () => {
  expect(managedEndpointDigestInput("dev_alex", "fixture-user", "fixture-env", 0)).toBe(
    "dev_alex:fixture-user:fixture-env",
  );
  expect(managedEndpointDigestInput("dev_alex", "fixture-user", "fixture-env", 1)).toBe(
    '\u0000["goat-managed-endpoint-v1","dev_alex","fixture-user","fixture-env",1]',
  );
  expect(() =>
    managedEndpointDigestInput("prod", "fixture-user", "fixture-env", 2147483647),
  ).toThrow();
});

it("separates new generations from colon-suffixed legacy ids and component boundaries", () => {
  const identities = [
    managedEndpointDigestInput("prod", "owner", "foo", 1),
    managedEndpointDigestInput("prod", "owner", "foo:1", 0),
    managedEndpointDigestInput("prod", "owner:foo", "bar", 1),
    managedEndpointDigestInput("prod", "owner", "foo:bar", 1),
    managedEndpointDigestInput("prod", "owner", "foo", 2),
    managedEndpointDigestInput("preview", "owner", "foo", 1),
  ];
  expect(new Set(identities).size).toBe(identities.length);
});
