import { describe, expect, it } from "vite-plus/test";
import { isServerNetworkAccessible } from "./serverNetworkAccessible";

describe("isServerNetworkAccessible", () => {
  const served = [{ kind: "tailnet", httpBaseUrl: "https://host.example.ts.net:8443/" }] as const;
  it.each([
    { authPolicy: "remote-reachable", directEndpoints: undefined, expected: true },
    { authPolicy: "loopback-browser", directEndpoints: undefined, expected: false },
    { authPolicy: "loopback-browser", directEndpoints: [], expected: false },
    { authPolicy: "loopback-browser", directEndpoints: served, expected: true },
    { authPolicy: null, directEndpoints: served, expected: false },
  ] as const)("$authPolicy with $directEndpoints.length endpoints", (row) => {
    expect(
      isServerNetworkAccessible(row.authPolicy, { directEndpoints: row.directEndpoints }),
    ).toBe(row.expected);
  });
});
