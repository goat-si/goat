import type { HostStatusEntry, HubNode, OpenCodexChildBootstrapStatus } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";

import { cloudAutoJoinSaveError, hubDeviceList, presentChildSetup } from "./hubDevices.ts";
import type { HubDevice, HubSnapshot } from "./state/hubFleet.ts";

function node(
  nodeId: string,
  label: string,
  targets: ReadonlyArray<HubNode["routes"][number]["target"]>,
): HubNode {
  return {
    nodeId,
    environmentId: null,
    label,
    kind: targets[0]!.kind,
    routes: targets.map((target) => ({
      routeId: `${target.kind}:${target.kind === "linked" ? target.name : target.alias}`,
      source: target.kind === "cloud" ? "cloud-machine" : "registered",
      target,
      status: "online",
      checkedAt: null,
      lastSeenAt: null,
      lastError: null,
    })),
    status: "online",
    lastSeenAt: null,
    addedBy: null,
  } as HubNode;
}

const ssh = (alias: string) =>
  ({ kind: "ssh", alias, hostname: null, username: null, port: null }) as const;
const cloud = (alias: string) => ({ kind: "cloud", alias }) as HubNode["routes"][number]["target"];

function device(alias: string, transport: HubDevice["transport"] = "remote-link"): HubDevice {
  return {
    alias,
    transport,
    reachability: "ok",
    tunnel: transport === "remote-link" ? "connected" : null,
    parity: null,
    version: "2.89.0",
    versionVerdict: "compatible",
    fallback: "unknown",
    pressure: null,
  };
}

function snapshot(devices: ReadonlyArray<HubDevice>): HubSnapshot {
  return { homeName: "jun-mbp", homeVersion: "2.89.0", homeHealthy: true, homeKey: "", devices };
}

function host(
  alias: string,
  opencodexChild?: OpenCodexChildBootstrapStatus,
  opencodexChildOptIn?: boolean,
): HostStatusEntry {
  return {
    host: alias,
    reachability: "ok",
    ...(opencodexChild === undefined ? {} : { opencodexChild }),
    ...(opencodexChildOptIn === undefined ? {} : { opencodexChildOptIn }),
  };
}

describe("presentChildSetup", () => {
  it("names the reason and keeps the Home's message for each unfinished state", () => {
    expect(presentChildSetup({ state: "running", checkedAt: 1 })).toEqual({
      state: "running",
      tone: "progress",
      label: "Setting up as OpenCodex Child",
      detail: null,
      checkedAt: 1,
    });
    expect(
      presentChildSetup({
        state: "blocked",
        reason: "npm_missing",
        message: "npm is not on the machine's PATH.",
        checkedAt: 2,
      }),
    ).toMatchObject({
      tone: "destructive",
      label: "OpenCodex Child setup blocked: npm missing",
      detail: "npm is not on the machine's PATH.",
    });
    expect(
      presentChildSetup({ state: "degraded", message: "Parity P5 failed.", checkedAt: 3 }),
    ).toMatchObject({ tone: "warning", label: "OpenCodex Child degraded" });
  });

  it("says nothing once the machine is a Child or when an older Home sent no status", () => {
    expect(presentChildSetup({ state: "child", checkedAt: 1 })).toBeNull();
    expect(presentChildSetup(undefined)).toBeNull();
  });
});

describe("hubDeviceList", () => {
  it("joins a hub node and its OpenCodex device into one row and keeps machines only one side knows", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "Mac mini", [ssh("macmini-ts")]), node("n2", "lidge", [ssh("lidge-ts")])],
      snapshot: snapshot([device("macmini-ts"), device("studio-ts", "standalone")]),
      hosts: [],
    });
    expect(
      rows.map((row) => [row.key, row.node?.nodeId ?? null, row.device?.alias ?? null]),
    ).toEqual([
      ["node:n1", "n1", "macmini-ts"],
      ["node:n2", "n2", null],
      ["device:studio-ts", null, "studio-ts"],
    ]);
  });

  it("prefers a route alias over a label that equals another machine's alias", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "lidge-ts", [ssh("other")]), node("n2", "Lidge", [ssh("lidge-ts")])],
      snapshot: snapshot([device("lidge-ts")]),
      hosts: [],
    });
    expect(rows.find((row) => row.device !== null)?.node?.nodeId).toBe("n2");
    expect(rows).toHaveLength(2);
  });

  it("lets a node's route alias win over its own label whatever order the devices come in", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "label-name", [ssh("route-name")])],
      snapshot: snapshot([device("label-name"), device("route-name")]),
      hosts: [],
    });
    expect(rows.map((row) => [row.key, row.device?.alias ?? null])).toEqual([
      ["node:n1", "route-name"],
      ["device:label-name", "label-name"],
    ]);
  });

  it("puts each machine's setup on one row only, the one whose route names it", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "boat-2", [cloud("boat-1")]), node("n2", "second", [cloud("boat-2")])],
      snapshot: null,
      hosts: [host("boat-2", { state: "running", checkedAt: 1 })],
    });
    expect(rows.map((row) => [row.key, row.childSetup?.state ?? null])).toEqual([
      ["node:n1", null],
      ["node:n2", "running"],
    ]);
  });

  it("shows the Home's setup on the cloud machine's row, and alone when nothing else lists it", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "boat-1", [cloud("boat-1")])],
      snapshot: null,
      hosts: [
        host("boat-1", { state: "blocked", reason: "npm_missing", checkedAt: 1 }),
        host("boat-2", { state: "running", checkedAt: 1 }),
        host("boat-3", { state: "child", checkedAt: 1 }),
        host("macmini-ts"),
      ],
    });
    expect(rows.map((row) => [row.key, row.childSetup?.label ?? null])).toEqual([
      ["node:n1", "OpenCodex Child setup blocked: npm missing"],
      ["setup:boat-2", "Setting up as OpenCodex Child"],
    ]);
  });

  it("still lists OpenCodex devices when the hub cannot list its nodes", () => {
    const rows = hubDeviceList({
      nodes: null,
      snapshot: snapshot([device("macmini-ts")]),
      hosts: [],
    });
    expect(rows.map((row) => row.key)).toEqual(["device:macmini-ts"]);
  });

  it("offers the Child setup switch only for SSH hosts the hub says it can join", () => {
    const rows = hubDeviceList({
      nodes: [node("n1", "Mac mini", [ssh("macmini-ts")])],
      snapshot: null,
      hosts: [
        host("macmini-ts", undefined, true),
        host("lidge-ts", undefined, false),
        // An older hub sends no switch for its hosts, so none is offered.
        host("studio-ts"),
      ],
    });
    expect(rows.map((row) => [row.key, row.childOptIn])).toEqual([
      ["node:n1", { host: "macmini-ts", enabled: true }],
      ["setup:lidge-ts", { host: "lidge-ts", enabled: false }],
    ]);
  });

  it("says why an SSH host's Child setup was turned off", () => {
    const rows = hubDeviceList({
      nodes: null,
      snapshot: null,
      hosts: [
        host(
          "lidge-ts",
          {
            state: "blocked",
            reason: "consent_revoked",
            message: "Turn it on again.",
            checkedAt: 1,
          },
          false,
        ),
      ],
    });
    expect(rows[0]).toMatchObject({
      childOptIn: { host: "lidge-ts", enabled: false },
      childSetup: {
        label:
          "OpenCodex Child setup blocked: turned off because the session that allowed it lost access",
        detail: "Turn it on again.",
      },
    });
  });
});

describe("cloudAutoJoinSaveError", () => {
  it("flags an older hub that kept joining cloud machines after the switch was turned off", () => {
    expect(cloudAutoJoinSaveError(false, true)).toMatch(/older GOAT/);
    expect(cloudAutoJoinSaveError(false, false)).toBeNull();
    expect(cloudAutoJoinSaveError(true, true)).toBeNull();
  });
});
