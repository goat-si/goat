import { expect, it } from "@effect/vitest";
import type { OpenCodexInventorySnapshot } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { parityVerdict } from "./parity.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

it.effect.each(["mac-studio", "macmini-ts", "lidge-ts"] as const)(
  "%s uses Home-owned links and only missing settings fails P6",
  (deviceAlias) =>
    Effect.sync(() => {
      const home = fleetSnapshot("home");
      const device = fleetSnapshot(deviceAlias);
      expect(home.link.links).toHaveLength(5);
      expect(device.link.links).toEqual([]);
      const result = parityVerdict({ deviceAlias, checkedAt: 100_000, home, device });
      expect(result.verdict).toBe(deviceAlias === "mac-studio" ? "unproven" : "degraded");
      expect(result.failingCheckIds).toEqual(deviceAlias === "mac-studio" ? [] : ["P6"]);
      expect(result.checks.find(({ id }) => id === "P2")?.status).toBe("ok");
      expect(result.checks.find(({ id }) => id === "P4")?.status).toBe("unproven");
      expect(result.checks.find(({ id }) => id === "P5")?.status).toBe("skipped");
    }),
);

it.effect("Windows with a Home tunnel but no working Child is broken", () =>
  Effect.sync(() => {
    const result = parityVerdict({
      deviceAlias: "mini",
      checkedAt: 0,
      home: fleetSnapshot("home"),
    });
    expect(result.verdict).toBe("broken");
    expect(result.failingCheckIds).toEqual(["P1", "P3"]);
  }),
);

it.effect("unreachable Home cannot be proven by a healthy Child's cached catalog", () =>
  Effect.sync(() => {
    const result = parityVerdict({
      deviceAlias: "mac-studio",
      checkedAt: 0,
      device: fleetSnapshot("mac-studio"),
    });
    expect(result.verdict).toBe("broken");
    expect(result.failingCheckIds).toEqual(["P2", "P3"]);
  }),
);

it.effect.each([
  ["wrong role", "P1", "broken"],
  ["missing Home record", "P2", "broken"],
  ["disconnected tunnel", "P2", "broken"],
  ["wrong link", "P2", "broken"],
  ["models HTTP failure", "P3", "broken"],
  ["catalog drift", "P3", "broken"],
  ["wrong Home", "P4", "broken"],
  ["runtime predates apply", "P5", "degraded"],
  ["settings drift", "P6", "degraded"],
  ["stale settings link", "P6", "degraded"],
  ["client bypass", "P7", "degraded"],
  ["local leak", "P8", "degraded"],
] as const)("%s reports %s", ([scenario, id, verdict]) =>
  Effect.sync(() => {
    const home = fleetSnapshot("home");
    const device = fleetSnapshot("mac-studio");
    const evidence = { ...device.parityEvidence!, servedBy: home.parityEvidence!.instanceId! };
    let changedHome: OpenCodexInventorySnapshot = home;
    const changedDevice: OpenCodexInventorySnapshot = { ...device, parityEvidence: evidence };
    switch (scenario) {
      case "wrong role":
        evidence.healthRole = "standalone";
        break;
      case "missing Home record":
        changedHome = { ...home, link: { ...home.link, links: [] } };
        break;
      case "disconnected tunnel":
        changedHome = {
          ...home,
          link: {
            ...home.link,
            links: home.link.links.map((link) => ({ ...link, state: "failed" })),
          },
        };
        break;
      case "wrong link":
        evidence.childLinkId = "another-link";
        evidence.settingsLinkId = "another-link";
        break;
      case "models HTTP failure":
        evidence.modelsStatus = 503;
        break;
      case "catalog drift":
        evidence.catalogDigest = "different";
        break;
      case "wrong Home":
        evidence.servedBy = "another-home";
        break;
      case "runtime predates apply":
        evidence.startedAt = 100;
        changedHome = {
          ...home,
          link: {
            ...home.link,
            links: home.link.links.map((link) => ({ ...link, lastApplyAt: 101 })),
          },
        };
        break;
      case "settings drift":
        evidence.settingsDigest = "different";
        break;
      case "stale settings link":
        evidence.settingsLinkId = "another-link";
        break;
      case "client bypass":
        evidence.wiring = [{ status: "failed", reason: "Client bypasses local OpenCodex." }];
        break;
      case "local leak":
        evidence.localProviderCount = 1;
        break;
    }
    const result = parityVerdict({
      deviceAlias: "mac-studio",
      checkedAt: 0,
      home: changedHome,
      device: changedDevice,
    });
    expect(result.verdict).toBe(verdict);
    expect(result.failingCheckIds).toEqual([id]);
  }),
);

it.effect("all proven checks pass, and unavailable freshness does not prevent ok", () =>
  Effect.sync(() => {
    const home = fleetSnapshot("home");
    const device = fleetSnapshot("mac-studio");
    const result = parityVerdict({
      deviceAlias: "mac-studio",
      checkedAt: 123,
      home,
      device: {
        ...device,
        parityEvidence: { ...device.parityEvidence!, servedBy: home.parityEvidence!.instanceId! },
      },
    });
    expect(result).toMatchObject({ verdict: "ok", checkedAt: 123, failingCheckIds: [] });
  }),
);

it.effect("old inventories never become ok from inferred role and record presence", () =>
  Effect.sync(() => {
    const { parityEvidence: _evidence, ...device } = fleetSnapshot("mac-studio");
    const result = parityVerdict({
      deviceAlias: "mac-studio",
      checkedAt: 0,
      home: fleetSnapshot("home"),
      device,
    });
    expect(result.verdict).toBe("unproven");
    expect(result.failingCheckIds).toEqual([]);
  }),
);

const hubClientPair = (serverUrl: string | undefined, origin: string | undefined) => {
  const home = fleetSnapshot("home");
  const device = fleetSnapshot("macmini-ts");
  return {
    home: {
      ...home,
      link: {
        ...home.link,
        links: home.link.links.map((link) =>
          link.alias === "macmini-ts" ? { ...link, apiKeyId: "key_mini" } : link,
        ),
      },
      parityEvidence: {
        ...home.parityEvidence!,
        ...(origin === undefined ? {} : { hubDataOrigin: origin }),
      },
    },
    device: {
      ...device,
      link: { ...device.link, role: "none" as const },
      hubClient: { state: "connected" as const, apiKeyId: "key_mini" },
      parityEvidence: {
        ...device.parityEvidence!,
        ...(serverUrl === undefined ? {} : { hubServerUrl: serverUrl }),
      },
    },
  };
};

it.effect.each([
  ["this Home's origin", "https://hub.tail.ts.net:8443/", "https://hub.tail.ts.net:8443", "ok"],
  ["another hub", "https://other.tail.ts.net:8443", "https://hub.tail.ts.net:8443", "failed"],
  ["no advertised origin", "https://hub.tail.ts.net:8443", undefined, "unproven"],
] as const)("a Hub client's P4 compares the hub URL it uses with %s", ([, url, origin, status]) =>
  Effect.sync(() => {
    const result = parityVerdict({
      deviceAlias: "macmini-ts",
      checkedAt: 100_000,
      ...hubClientPair(url, origin),
    });
    expect(result.checks.find(({ id }) => id === "P2")?.status).toBe("ok");
    expect(result.checks.find(({ id }) => id === "P4")?.status).toBe(status);
  }),
);
