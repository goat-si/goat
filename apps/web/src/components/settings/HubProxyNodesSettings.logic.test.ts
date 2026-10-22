import {
  EnvironmentId,
  HubProxyRpcError,
  type HubNode,
  type HubNodeRoute,
  type ServerConfig,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canShowHubProxySettings,
  hubProxyFailureMessage,
  hubProxyNodeActions,
} from "./HubProxyNodesSettings.logic";

const route = (target: HubNodeRoute["target"]): HubNodeRoute => ({
  routeId: `${target.kind}:box`,
  source: "registered",
  target,
  status: "unknown",
  checkedAt: null,
  lastSeenAt: null,
  lastError: null,
});
const ssh = route({ kind: "ssh", alias: "box", hostname: null, username: null, port: null });
const linked = route({
  kind: "linked",
  name: "box",
  baseUrl: "https://box.test",
  access: "read-only",
  expiresAt: "2030-01-01T00:00:00.000Z",
});
const cloud = route({ kind: "cloud", alias: "boat-box" });
const node = (routes: readonly HubNodeRoute[], known = false): HubNode => ({
  nodeId: "box",
  environmentId: known ? EnvironmentId.make("box") : null,
  label: "Box",
  kind: routes[0]!.target.kind,
  routes,
  status: "unknown",
  lastSeenAt: null,
  addedBy: null,
});

describe("hub proxy settings", () => {
  it("offers setup only while an SSH node's identity is unknown", () => {
    expect(hubProxyNodeActions(node([ssh]))).toEqual({
      setup: true,
      linked: false,
      reachable: false,
    });
    expect(hubProxyNodeActions(node([ssh], true))).toEqual({
      setup: false,
      linked: false,
      reachable: true,
    });
  });
  it("offers enrollment only when the hub reaches the node over its linked route", () => {
    expect(hubProxyNodeActions(node([linked]))).toEqual({
      setup: false,
      linked: true,
      reachable: false,
    });
    // SSH is preferred, so a pairing link for the secondary linked route could never be used.
    expect(hubProxyNodeActions(node([ssh, linked], true))).toEqual({
      setup: false,
      linked: false,
      reachable: true,
    });
  });
  it("advertises known cloud nodes without offering SSH setup or linked enrollment", () => {
    expect(hubProxyNodeActions(node([cloud], true))).toEqual({
      setup: false,
      linked: false,
      reachable: true,
    });
    expect(hubProxyNodeActions(node([cloud])).reachable).toBe(false);
  });
  it("requires a capable hub and its settings permission", () => {
    const config = (hubProxy: boolean) =>
      ({ environment: { capabilities: { hubProxy } } }) as ServerConfig;
    expect(canShowHubProxySettings(config(true), true)).toBe(true);
    expect(canShowHubProxySettings(config(false), true)).toBe(false);
    expect(canShowHubProxySettings(config(true), false)).toBe(false);
    expect(canShowHubProxySettings(null, true)).toBe(false);
  });
  it("shows server detail for typed and serialized RPC failures", () => {
    const error = new HubProxyRpcError({
      reason: "refused",
      detail: "The pairing link belongs to a different machine.",
    });
    expect(hubProxyFailureMessage(error, "fallback")).toBe(error.detail);
    expect(hubProxyFailureMessage({ detail: error.detail }, "fallback")).toBe(error.detail);
    expect(hubProxyFailureMessage(new Error("Disconnected"), "fallback")).toBe("Disconnected");
    expect(hubProxyFailureMessage({}, "fallback")).toBe("fallback");
  });
});
