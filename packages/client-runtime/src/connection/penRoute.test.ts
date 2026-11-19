import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { PenConnectionProfile } from "./catalog.ts";
import {
  HubProxyConnectionTarget,
  PenConnectionTarget,
  SshConnectionTarget,
  penConnectionId,
} from "./model.ts";
import {
  connectionRouteKind,
  insertRoute,
  usableRoutes,
  makeConnectionRouteEnablement,
} from "./routes.ts";
import { isLocalServerConnection } from "./loopbackHost.ts";

const environmentId = EnvironmentId.make("pen-test");
const target = new PenConnectionTarget({
  environmentId,
  label: "Pen",
  connectionId: penConnectionId("mesh", "node"),
});
const profile = new PenConnectionProfile({
  environmentId,
  label: "Pen",
  connectionId: target.connectionId,
  meshId: "mesh",
  nodeId: "node",
  noisePub: "key",
});
const pen = { target, profile: Option.some(profile) };

describe("Pen routes", () => {
  it("SSH precedes native Pen and native Pen precedes hub", () => {
    const hub = {
      target: new HubProxyConnectionTarget({ environmentId, label: "Hub", connectionId: "hub" }),
      profile: Option.none(),
    };
    const ssh = {
      target: new SshConnectionTarget({ environmentId, label: "SSH", connectionId: "ssh" }),
      profile: Option.none(),
    };
    expect(insertRoute(insertRoute([hub], pen), ssh).map(connectionRouteKind)).toEqual([
      "ssh",
      "pen",
      "hub-proxy",
    ]);
  });
  it("closed viewer gate excludes persisted Pen routes", () => {
    expect(usableRoutes({ ...pen, enabled: true })).toEqual([]);
  });
  it("an injected viewer policy controls Pen route availability", () => {
    expect(makeConnectionRouteEnablement({ enabled: false })(pen)).toBe(false);
    expect(makeConnectionRouteEnablement({ enabled: true })(pen)).toBe(true);
  });
  it("a Pen route is not this device", () => {
    expect(isLocalServerConnection(target, "http://127.0.0.1:1234")).toBe(false);
  });
});
