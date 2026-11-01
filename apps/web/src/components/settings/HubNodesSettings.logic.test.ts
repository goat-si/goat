import { describe, expect, it } from "vite-plus/test";
import {
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { catalogToImportInput } from "../desktop/hubNodesImport.logic";
import * as Cause from "effect/Cause";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { EnvironmentId, type HubNode, type HubNodeRoute } from "@goat/contracts";
import {
  savedHubNodeProfiles,
  canRemoveHubNode,
  hubNodeLastSeenLabel,
  hubNodeRemovalInput,
  hubNodeStatusLabel,
  isHubNodesUnsupportedError,
} from "./HubNodesSettings.logic";

const ssh: HubNodeRoute = {
  routeId: "ssh:host",
  source: "registered",
  target: { kind: "ssh", alias: "host", hostname: null, username: null, port: null },
  status: "unknown",
  checkedAt: null,
  lastSeenAt: null,
  lastError: null,
};
const linked: HubNodeRoute = {
  ...ssh,
  routeId: "linked:host",
  source: "linked-host",
  target: {
    kind: "linked",
    name: "host",
    baseUrl: "https://host.test",
    access: "read-only",
    expiresAt: "2026-10-20T00:00:00.000Z",
  },
};
const cloud: HubNodeRoute = {
  ...ssh,
  routeId: "cloud:boat-host",
  source: "cloud-machine",
  target: { kind: "cloud", alias: "boat-host" },
};
function node(routes: readonly HubNodeRoute[]): HubNode {
  return {
    nodeId: "host",
    environmentId: EnvironmentId.make("env-host"),
    label: "Host",
    kind: routes[0]!.target.kind,
    routes,
    status: "unknown",
    lastSeenAt: null,
    addedBy: null,
  };
}

describe("hub node presentation", () => {
  it("labels all status states", () => {
    expect(
      ["online", "offline", "unknown"].map((status) =>
        hubNodeStatusLabel(status as HubNode["status"]),
      ),
    ).toEqual(["Online", "Offline", "Not checked"]);
  });
  it("omits absent or invalid last seen times", () => {
    expect(hubNodeLastSeenLabel(null, 0)).toBeNull();
    expect(hubNodeLastSeenLabel("invalid", 0)).toBeNull();
  });
  it("formats relative last seen and clamps clock skew", () => {
    const lastSeen = "2026-10-20T00:00:00.000Z";
    const at = Date.parse(lastSeen);
    expect(
      [at - 60_000, at + 59_000, at + 60_000, at + 120 * 60_000, at + 2 * 86_400_000].map((now) =>
        hubNodeLastSeenLabel(lastSeen, now),
      ),
    ).toEqual([
      "last seen just now",
      "last seen just now",
      "last seen 1m ago",
      "last seen 2h ago",
      "last seen 2d ago",
    ]);
  });
  it("allows SSH and linked removal, protects cloud-only nodes", () => {
    expect(canRemoveHubNode(node([ssh]))).toBe(true);
    expect(canRemoveHubNode(node([linked]))).toBe(true);
    expect(canRemoveHubNode(node([cloud]))).toBe(false);
    expect(canRemoveHubNode(node([ssh, cloud]))).toBe(true);
  });
  it("targets only a removable route on mixed cloud nodes", () => {
    expect(hubNodeRemovalInput(node([ssh, linked]))).toEqual({ nodeId: "host" });
    expect(hubNodeRemovalInput(node([ssh, cloud]))).toEqual({
      nodeId: "host",
      routeId: "ssh:host",
    });
    expect(hubNodeRemovalInput(node([cloud, linked]))).toEqual({
      nodeId: "host",
      routeId: "linked:host",
    });
  });
});

describe("unsupported hub RPC", () => {
  it("recognizes Effect RPC unknown-tag defects from an older server", () => {
    expect(
      isHubNodesUnsupportedError(
        Cause.squash(Cause.die("Unknown request tag: hub.nodes.subscribe")),
      ),
    ).toBe(true);
    expect(isHubNodesUnsupportedError(new Error("Unknown request tag: hub.nodes.subscribe"))).toBe(
      true,
    );
  });
  it("unwraps RpcClientError protocol defects and causes", () => {
    const error = new RpcClientError({
      reason: new RpcClientDefect({
        message: "Server defect",
        cause: new Error("Unknown request tag: hub.nodes.subscribe"),
      }),
    });
    expect(isHubNodesUnsupportedError(error)).toBe(true);
    expect(isHubNodesUnsupportedError(Cause.fail(error))).toBe(true);
    expect(isHubNodesUnsupportedError(Cause.die("Unknown request tag: hub.nodes.subscribe"))).toBe(
      true,
    );
    expect(isHubNodesUnsupportedError({ code: -32601, message: "Method not found" })).toBe(false);
    expect(isHubNodesUnsupportedError(new Error("hub.nodes.subscribe method not supported"))).toBe(
      false,
    );
  });
  it("keeps permission, transport and service failures visible", () => {
    for (const error of [
      new Error("permission denied"),
      new Error("Unknown request tag: other.subscribe"),
      new Error("hub.nodes.subscribe connection lost"),
      { _tag: "HubNodesError", reason: "storage_failed", detail: "database unavailable" },
      null,
    ])
      expect(isHubNodesUnsupportedError(error)).toBe(false);
  });
  it("bounds traversal of cyclic errors", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(isHubNodesUnsupportedError(error)).toBe(false);
  });
});

describe("saved desktop profiles", () => {
  it("lists unregistered profiles beyond the first 500 while capping only import payloads", () => {
    const entries = Array.from({ length: 502 }, (_, index): ConnectionCatalogEntry => {
      const environmentId = EnvironmentId.make(`env-${index}`);
      const alias = `host-${index}`;
      return {
        target: new SshConnectionTarget({ environmentId, connectionId: alias, label: alias }),
        profile: Option.some(
          new SshConnectionProfile({
            environmentId,
            connectionId: alias,
            label: alias,
            target: { alias, hostname: "example.com", username: null, port: null },
          }),
        ),
        enabled: true,
      };
    });
    const registered = entries
      .slice(0, 500)
      .map((entry) => ({ ...node([ssh]), environmentId: entry.target.environmentId }));
    expect(savedHubNodeProfiles(entries, registered).map((profile) => profile.ssh.alias)).toEqual([
      "host-500",
      "host-501",
    ]);
    const payload = catalogToImportInput(entries);
    expect(payload.catalog.state === "readable" && payload.catalog.profiles.length).toBe(500);
    expect(savedHubNodeProfiles([{ ...entries[500]!, enabled: false }], [])).toEqual([]);
  });
});
