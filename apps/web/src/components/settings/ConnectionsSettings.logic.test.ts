import type { AdvertisedEndpoint, DesktopWslState } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildClientPairingQrPayload,
  buildHubPhoneQrPayload,
  selectHubPhoneQrTarget,
  applyWslEnableSelection,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "relay:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["relay:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

function makeTailnetEndpoint(overrides: Partial<AdvertisedEndpoint> = {}): AdvertisedEndpoint {
  return makeEndpoint({
    id: "tailscale-ip:http://100.84.12.7:4780",
    provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
    reachability: "private-network",
    httpBaseUrl: "http://100.84.12.7:4780",
    wsBaseUrl: "ws://100.84.12.7:4780",
    ...overrides,
  });
}

function makeHttpsEndpoint(overrides: Partial<AdvertisedEndpoint> = {}): AdvertisedEndpoint {
  return makeTailnetEndpoint({
    id: "tailscale-magicdns:https://hub.tail.ts.net/",
    httpBaseUrl: "https://hub.tail.ts.net/",
    wsBaseUrl: "wss://hub.tail.ts.net/",
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    ...overrides,
  });
}

describe("selectHubPhoneQrTarget", () => {
  it("prefers available Tailscale HTTPS over tailnet IP and default LAN", () => {
    const lan = makeEndpoint({ isDefault: true });
    const ip = makeTailnetEndpoint();
    const https = makeHttpsEndpoint();
    const endpoints = [lan, ip, https];
    expect(selectHubPhoneQrTarget(endpoints)).toEqual({
      endpoint: https,
      endpointOrigin: "https://hub.tail.ts.net",
      kind: "tailscale-https",
    });
    expect(endpoints).toEqual([lan, ip, https]);
  });

  it("selects tailnet before LAN when HTTPS is unavailable", () => {
    expect(
      selectHubPhoneQrTarget([
        makeEndpoint({}),
        makeHttpsEndpoint({ status: "unavailable" }),
        makeTailnetEndpoint(),
      ]),
    ).toMatchObject({ kind: "tailnet", endpointOrigin: "http://100.84.12.7:4780" });
  });

  it("selects LAN only as the last explicit fallback", () => {
    expect(
      selectHubPhoneQrTarget([makeHttpsEndpoint({ status: "unknown" }), makeEndpoint({})]),
    ).toMatchObject({ kind: "lan", endpointOrigin: "http://192.168.1.42:4780" });
  });

  it("keeps inventory order within a tier instead of following isDefault", () => {
    const first = makeTailnetEndpoint();
    const second = makeTailnetEndpoint({
      id: "tailscale-ip:http://100.84.12.8:4780",
      isDefault: true,
      httpBaseUrl: "http://100.84.12.8:4780",
    });
    expect(selectHubPhoneQrTarget([first, second])?.endpoint.id).toBe(first.id);
  });

  it.each([
    makeEndpoint({ reachability: "loopback", httpBaseUrl: "http://127.0.0.1:4780" }),
    makeEndpoint({ httpBaseUrl: "http://localhost:4780" }),
    makeEndpoint({ httpBaseUrl: "http://[::1]:4780" }),
    makeEndpoint({ status: "unknown" }),
    makeEndpoint({ status: "unavailable" }),
    makeEndpoint({ reachability: "public" }),
    makeEndpoint({ reachability: "private-network" }),
    makeEndpoint({ httpBaseUrl: "not a URL" }),
    makeEndpoint({ httpBaseUrl: "file:///tmp/goat" }),
    makeEndpoint({ httpBaseUrl: "https://user:pass@host.example" }),
  ])("rejects an unsuitable advertised endpoint (%o)", (endpoint) => {
    expect(selectHubPhoneQrTarget([endpoint])).toBeNull();
  });

  it("returns null for no advertisements", () => {
    expect(selectHubPhoneQrTarget([])).toBeNull();
  });
});

describe("buildHubPhoneQrPayload", () => {
  it("encodes a direct pairing URL in the GOAT scheme even for hosted-compatible HTTPS", () => {
    const target = selectHubPhoneQrTarget([makeHttpsEndpoint()])!;
    const payload = buildHubPhoneQrPayload(target, "PAIR1234");
    expect(payload).toBe(
      "goat://pair?pairingUrl=https%3A%2F%2Fhub.tail.ts.net%2Fpair%23token%3DPAIR1234",
    );
    const direct = new URL(new URL(payload).searchParams.get("pairingUrl")!);
    expect(direct.origin).toBe("https://hub.tail.ts.net");
    expect(direct.pathname).toBe("/pair");
    expect(direct.searchParams.has("host")).toBe(false);
    expect(direct.searchParams.has("token")).toBe(false);
    expect(new URLSearchParams(direct.hash.slice(1)).get("token")).toBe("PAIR1234");
  });

  it("preserves a custom HTTPS port and discards base paths and hosted query fields", () => {
    const target = selectHubPhoneQrTarget([
      makeHttpsEndpoint({
        httpBaseUrl: "https://hub.tail.ts.net:8443/old?host=wrong.example#old",
      }),
    ])!;
    const payload = buildHubPhoneQrPayload(target, "PAIR +&%/#?");
    const inner = new URL(payload).searchParams.get("pairingUrl")!;
    const direct = new URL(inner);
    expect(direct.origin).toBe("https://hub.tail.ts.net:8443");
    expect(direct.pathname).toBe("/pair");
    expect(direct.search).toBe("");
    expect(new URLSearchParams(direct.hash.slice(1)).get("token")).toBe("PAIR +&%/#?");
    expect(payload).toBe(`goat://pair?pairingUrl=${encodeURIComponent(inner)}`);
  });

  it("wraps an explicitly selected LAN target as a direct app pairing link", () => {
    const target = selectHubPhoneQrTarget([makeEndpoint({})])!;
    expect(new URL(buildHubPhoneQrPayload(target, "LAN1234")).searchParams.get("pairingUrl")).toBe(
      "http://192.168.1.42:4780/pair#token=LAN1234",
    );
  });
});

describe("buildClientPairingQrPayload", () => {
  it("unwraps hosted browser links to the direct server URL for phone QR codes", () => {
    const hosted = new URL("https://app.t3.codes/pair");
    hosted.searchParams.set("host", "https://hub.tail.ts.net:8443/old?host=wrong.example");
    hosted.hash = new URLSearchParams({ token: "PHONE +&%/#?" }).toString();
    const browserLink = hosted.toString();
    const direct = new URL(
      new URL(buildClientPairingQrPayload(browserLink)).searchParams.get("pairingUrl")!,
    );
    expect(direct.origin).toBe("https://hub.tail.ts.net:8443");
    expect(direct.pathname).toBe("/pair");
    expect(direct.search).toBe("");
    expect(new URLSearchParams(direct.hash.slice(1)).get("token")).toBe("PHONE +&%/#?");
    expect(hosted.toString()).toBe(browserLink);
  });

  it("keeps direct browser links inside the GOAT app payload", () => {
    const direct = "http://192.168.1.42:4780/pair#token=PAIR1234";
    expect(new URL(buildClientPairingQrPayload(direct)).searchParams.get("pairingUrl")).toBe(
      direct,
    );
  });
});

import { EnvironmentId, type SshHostStatus } from "@goat/contracts";
import {
  SshConnectionProfile,
  SshConnectionTarget,
  connectionRouteId,
  type ConnectionCatalogEntry,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { savedConnectionPresentation, savedConnectionSshRoute } from "./ConnectionsSettings.logic";

const sshEnvironmentId = EnvironmentId.make("fixture-vps");
const sshTarget = new SshConnectionTarget({
  environmentId: sshEnvironmentId,
  connectionId: "fixture-ssh",
  label: "Fixture VPS",
});
const sshEntry = {
  target: sshTarget,
  profile: Option.some(
    new SshConnectionProfile({
      environmentId: sshEnvironmentId,
      connectionId: "fixture-ssh",
      label: "Fixture VPS",
      target: { alias: "fixture-vps", hostname: "example.invalid", username: null, port: null },
    }),
  ),
  enabled: true,
};
const sshRouteId = connectionRouteId(sshTarget);
const readyRuntime: SshHostStatus = {
  host: "fixture-vps",
  state: "ready",
  runtimeVersion: null,
  requestedVersion: "0.4.3",
};
function rowPresentation(
  connection: EnvironmentConnectionPresentation,
  runtimeStatus = readyRuntime,
  enabled = true,
  entry: ConnectionCatalogEntry = sshEntry,
) {
  return savedConnectionPresentation({
    environment: { entry: { ...entry, enabled }, connection, serverConfig: null },
    runtimeStatus,
  });
}
function failedAttempt(
  failureAttempt: number,
  readyAttempt: number,
): EnvironmentConnectionPresentation {
  return {
    phase: "reconnecting",
    stage: "opening",
    error: "did not respond during connection setup",
    traceId: null,
    failure: {
      kind: "retrying",
      reason: "timeout",
      detail: "did not respond during connection setup",
    },
    failureOrigin: {
      supervisorId: "window-1",
      attemptId: failureAttempt,
      routeId: sshRouteId,
      stage: "preparing",
      setupTimeout: true,
    },
    sshRuntimeReady: {
      supervisorId: "window-1",
      attemptId: readyAttempt,
      routeId: sshRouteId,
      operationId: "operation-2",
      attachmentId: "attachment-2",
      runtimeStatus: readyRuntime,
    },
  };
}

describe("saved SSH row semantic status", () => {
  const alternateTarget = new SshConnectionTarget({
    ...sshTarget,
    connectionId: "fixture-ssh-alternate",
  });
  const alternateRouteId = connectionRouteId(alternateTarget);
  const entryWithAlternate = {
    ...sshEntry,
    alternateRoutes: [
      {
        target: alternateTarget,
        profile: Option.some(
          new SshConnectionProfile({
            ...Option.getOrThrow(sshEntry.profile),
            connectionId: alternateTarget.connectionId,
            target: {
              alias: "fixture-vps-alternate",
              hostname: "alternate.example.invalid",
              username: null,
              port: null,
            },
          }),
        ),
      },
    ],
  };
  function alternateAttempt(failureAttempt: number, readyAttempt: number) {
    const connection = failedAttempt(failureAttempt, readyAttempt);
    return {
      ...connection,
      failureOrigin: { ...connection.failureOrigin!, routeId: alternateRouteId },
      sshRuntimeReady: { ...connection.sshRuntimeReady!, routeId: alternateRouteId },
    };
  }
  it.each(["preparation", "ready", "failure", "none", "unknown"] as const)(
    "selects the runtime target from %s route evidence",
    (evidence) => {
      const connection = alternateAttempt(1, 2);
      const { sshRuntimeReady, failureOrigin, ...withoutEvidence } = connection;
      const selected = savedConnectionSshRoute({
        entry: entryWithAlternate,
        serverConfig: null,
        connection: {
          ...withoutEvidence,
          ...(evidence === "ready" ? { sshRuntimeReady } : {}),
          ...(evidence === "failure" ? { failureOrigin } : {}),
          ...(evidence === "preparation"
            ? {
                sshPreparation: {
                  supervisorId: "window-1",
                  attemptId: 2,
                  routeId: alternateRouteId,
                  operationId: "operation-2",
                  phase: "uploading",
                  hostAnswered: true,
                },
                sshRuntimeReady: { ...sshRuntimeReady!, routeId: sshRouteId },
              }
            : {}),
          ...(evidence === "unknown"
            ? { sshRuntimeReady: { ...sshRuntimeReady!, routeId: "removed-route" } }
            : {}),
        },
      });
      if (evidence === "unknown") {
        expect(selected).toBeUndefined();
      } else {
        expect(selected?.target.hostname).toBe(
          evidence === "none" ? "example.invalid" : "alternate.example.invalid",
        );
      }
    },
  );
  it("shows preparation on a saved alternate SSH route without restoring the old timeout", () => {
    const connection = alternateAttempt(1, 2);
    const result = rowPresentation(
      {
        ...connection,
        sshPreparation: {
          supervisorId: "window-1",
          attemptId: 2,
          routeId: alternateRouteId,
          operationId: "operation-2",
          phase: "uploading",
          hostAnswered: true,
        },
      },
      readyRuntime,
      true,
      entryWithAlternate,
    );
    expect(result.text).toBe("Installing GOAT runtime — first setup can take a few minutes");
    expect(result.preparationPhase).toBe("uploading");
    expect(result.tone).toBe("muted");
    expect(result.tooltipText).not.toContain("did not respond");
  });
  it("keeps newer ready evidence on a saved alternate SSH route", () => {
    const result = rowPresentation(alternateAttempt(1, 2), readyRuntime, true, entryWithAlternate);
    expect(result.text).toBe("Runtime ready · Opening connection");
    expect(result.tone).toBe("muted");
    expect(result.tooltipText).not.toContain("did not respond");
  });
  it("keeps a fresh timeout on the active alternate SSH route visible", () => {
    const result = rowPresentation(alternateAttempt(3, 2), readyRuntime, true, entryWithAlternate);
    expect(result.tone).toBe("error");
    expect(result.text).toContain("did not respond");
    expect(result.tooltipText).toContain("did not respond");
  });
  it("shows a newer verified ready attempt over the older setup timeout in row and tooltip", () => {
    const result = rowPresentation(failedAttempt(1, 2));
    expect(result.text).toBe("Runtime ready · Opening connection");
    expect(result.tone).toBe("muted");
    expect(result.tooltipText).toContain("Runtime ready");
    expect(JSON.stringify(result)).not.toMatch(/unknown|did not respond/);
  });
  it.each([
    [2, 1],
    [2, 2],
  ])(
    "keeps timeout A%s against ready A%s, including a same-attempt socket timeout",
    (failure, ready) => {
      const result = rowPresentation(failedAttempt(failure, ready));
      expect(result.tone).toBe("error");
      expect(result.text).toContain("did not respond");
      expect(result.tooltipText).toContain("did not respond");
    },
  );
  it("does not turn a new poll of old readiness into new attempt evidence", () => {
    const connection = failedAttempt(2, 1);
    expect(rowPresentation(connection, { ...readyRuntime }).tone).toBe("error");
  });
  it.each(["route", "owner", "no-origin"])(
    "does not suppress incomparable %s evidence",
    (mismatch) => {
      const connection = failedAttempt(1, 2);
      const origin = connection.failureOrigin!;
      const { failureOrigin: _origin, ...withoutOrigin } = connection;
      const result = rowPresentation(
        mismatch === "no-origin"
          ? withoutOrigin
          : {
              ...connection,
              failureOrigin: {
                ...origin,
                ...(mismatch === "route"
                  ? { routeId: "another-route" }
                  : { supervisorId: "another-window" }),
              },
            },
      );
      expect(result.tone).toBe("error");
      expect(result.tooltipText).toContain("did not respond");
    },
  );
  it("uses the active matching phase once while the owner poll is still delayed", () => {
    const connection = failedAttempt(1, 2);
    const result = rowPresentation(
      {
        ...connection,
        sshPreparation: {
          supervisorId: "window-1",
          attemptId: 2,
          routeId: sshRouteId,
          operationId: "operation-2",
          phase: "uploading",
          hostAnswered: true,
        },
      },
      { ...readyRuntime, state: "preparing", phase: "checking" },
    );
    expect(result.text).toBe("Installing GOAT runtime — first setup can take a few minutes");
    expect(result.tone).toBe("muted");
    expect(result.runtimeText).toBeNull();
    expect(result.tooltipText).toBe(result.text);
  });
  it.each(["authentication", "configuration", "transport"] as const)(
    "preserves a fresh %s failure against old ready evidence",
    (reason) => {
      const result = rowPresentation({
        ...failedAttempt(2, 1),
        phase: reason === "transport" ? "reconnecting" : "error",
        error: "fresh failure",
        failure: { kind: "blocked", reason, detail: "fresh failure" },
      });
      expect(result.tone).toBe("error");
      expect(result.tooltipText).toContain("fresh failure");
    },
  );
  it.each(["failed", "untrusted", "stopped", "providers_not_ready", "update_waiting"] as const)(
    "does not let cached ready hide current owner %s",
    (state) => {
      expect(rowPresentation(failedAttempt(1, 2), { ...readyRuntime, state }).tone).toBe("error");
    },
  );
  it("keeps disabled, unsupported, and offline distinct from preparation", () => {
    const connection = failedAttempt(1, 2);
    expect(rowPresentation(connection, readyRuntime, false).text).toBe("Off");
    expect(rowPresentation({ ...connection, phase: "offline" }).text).toBe("Offline");
    expect(rowPresentation({ ...connection, phase: "unsupported" }).text).toBe(
      "Client not supported",
    );
  });
});

it("does not apply coherent evidence from a different saved SSH route to this row", () => {
  const connection = failedAttempt(1, 2);
  const result = rowPresentation({
    ...connection,
    failureOrigin: { ...connection.failureOrigin!, routeId: "another-saved-route" },
    sshRuntimeReady: { ...connection.sshRuntimeReady!, routeId: "another-saved-route" },
  });
  expect(result.tone).toBe("error");
  expect(result.text).toContain("did not respond");
});
