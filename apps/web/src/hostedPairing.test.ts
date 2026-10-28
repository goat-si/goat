import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isHostedStaticApp,
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["https://staging.app.trygoat.ai", "https://app.trygoat.ai"])(
    "recognizes root and approval only for the artifact’s configured origin %s",
    (origin) => {
      vi.stubEnv("VITE_HOSTED_APP_URL", origin);
      vi.stubEnv("VITE_HTTP_URL", "");
      vi.stubEnv("VITE_WS_URL", "");
      for (const path of ["/", "/connect", "/settings/connections"]) {
        expect(isHostedStaticApp(new URL(`${origin}${path}`))).toBe(true);
      }
      const other = origin.includes("staging")
        ? "https://app.trygoat.ai"
        : "https://staging.app.trygoat.ai";
      expect(isHostedStaticApp(new URL(other))).toBe(false);
      expect(isHostedStaticApp(new URL("https://preview.workers.dev"))).toBe(false);
    },
  );

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.exa.test/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("builds no hosted link when the build configures no hosted app", () => {
    expect(
      buildHostedPairingUrl({ host: "https://backend.example.com:3773", token: "pairing-token" }),
    ).toBeNull();
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.exa.test");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }) ?? "",
    );

    expect(url.origin).toBe("https://preview.exa.test");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });
});
