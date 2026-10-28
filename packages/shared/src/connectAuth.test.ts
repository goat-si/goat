import { normalizeConnectHostedOrigin } from "./connectAuth.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildConnectAuthorizeRequestUrl,
  connectLoopbackRedirectUri,
  readConnectAuthorizeRequest,
} from "./connectAuth.ts";

describe("connectAuth", () => {
  it("round-trips state, challenge, and loopback port through the authorize URL fragment", () => {
    const url = buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.exa.test",
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://app.exa.test");
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.search).toBe("");
    expect(readConnectAuthorizeRequest(parsed)).toEqual({
      state: "q7mK9xV2pL4nR8sT6wYzAQ",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      loopbackPort: 34338,
    });
    expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  });

  it("rejects authorize requests missing state, challenge, or port", () => {
    expect(readConnectAuthorizeRequest(new URL("https://app.exa.test/connect"))).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.exa.test/connect#state=abc&port=34338")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.exa.test/connect#challenge=abc&port=34338")),
    ).toBeNull();
    expect(
      readConnectAuthorizeRequest(new URL("https://app.exa.test/connect#state=abc&challenge=abc")),
    ).toBeNull();
  });

  it("rejects authorize requests whose loopback port is corrupted", () => {
    for (const port of ["", "abc", "-1", "0", "65536", "34338x", "34 38"]) {
      const url = new URL(
        `https://app.exa.test/connect#state=state-1&challenge=challenge-1&port=${encodeURIComponent(port)}`,
      );
      expect(readConnectAuthorizeRequest(url), port).toBeNull();
    }
  });
});

describe("Connect hosted origins", () => {
  it("keeps staging and production exact and rejects credentials, ports and redirect payloads", () => {
    expect(normalizeConnectHostedOrigin("https://app.trygoat.ai")).toBe("https://app.trygoat.ai");
    expect(normalizeConnectHostedOrigin("https://staging.app.trygoat.ai")).toBe(
      "https://staging.app.trygoat.ai",
    );
    for (const origin of [
      "https://app.trygoat.ai:444",
      "https://user:secret@app.trygoat.ai",
      "https://app.trygoat.ai/connect",
      "https://app.trygoat.ai?token=example",
      "http://app.trygoat.ai",
    ])
      expect(normalizeConnectHostedOrigin(origin)).toBeNull();
  });
});

it("binds a versioned CLI approval intent to its callback state", () => {
  const state = "s".repeat(22);
  const approval = {
    intent: {
      connectAuthPolicyVersion: 1 as const,
      environmentId: "host-1",
      environmentPublicKey: "host-key",
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      notificationsEnabled: false as const,
      liveActivitiesEnabled: false as const,
      managedTunnelsEnabled: true,
    },
    cliKeyThumbprint: "cli-key",
    approvalChallenge: "v".repeat(43),
    state,
  };
  const url = new URL(
    buildConnectAuthorizeRequestUrl({
      hostedAppUrl: "https://app.trygoat.ai",
      state,
      challenge: "c".repeat(43),
      loopbackPort: 34338,
      approval,
    }),
  );
  expect(readConnectAuthorizeRequest(url)?.approval).toEqual(approval);
  const params = new URLSearchParams(url.hash.slice(1));
  params.set("state", "x".repeat(22));
  url.hash = params.toString();
  expect(readConnectAuthorizeRequest(url)).toBeNull();
});
