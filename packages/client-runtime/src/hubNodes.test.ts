import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/rpc";
import { describe, expect, it } from "vite-plus/test";
import { hubDeviceAccess, isHubNodesUnsupportedError } from "./hubNodes.ts";

describe("hubDeviceAccess", () => {
  const session = (permissions: ReadonlyArray<"orchestration:read" | "hub:proxy">) => ({
    authenticated: true,
    auth: {
      policy: "remote-reachable" as const,
      bootstrapMethods: ["one-time-token" as const],
      sessionMethods: ["bearer-access-token" as const],
      sessionCookieName: "goat_session",
    },
    scopes: [],
    permissions,
  });
  it("names the one fix a phone needs before a hub's devices appear", () => {
    const base = { hubEnabled: true, hubProxySupported: true };
    expect(hubDeviceAccess({ ...base, session: session(["orchestration:read"]) })).toBe(
      "no-access",
    );
    expect(hubDeviceAccess({ ...base, session: session(["hub:proxy"]) })).toBe("ready");
    expect(hubDeviceAccess({ ...base, hubEnabled: false, session: session(["hub:proxy"]) })).toBe(
      "hub-off",
    );
    expect(
      hubDeviceAccess({ ...base, hubProxySupported: false, session: session(["hub:proxy"]) }),
    ).toBe("update-hub");
  });
});

describe("isHubNodesUnsupportedError", () => {
  it("recognizes Effect RPC unknown request tag defects and their wrappers", () => {
    const defect = "Unknown request tag: hub.nodes.add";
    expect(isHubNodesUnsupportedError(defect)).toBe(true);
    expect(isHubNodesUnsupportedError(Cause.die(defect))).toBe(true);
    expect(
      isHubNodesUnsupportedError(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({ message: "Remote defect", cause: defect }),
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isHubNodesUnsupportedError(new Error("Unknown request tag: hub.nodes.dismissNotice")),
    ).toBe(true);
  });

  it("does not hide authorization, network, unrelated RPC or ordinary hub failures", () => {
    for (const error of [
      new Error("Permission denied"),
      new Error("Connection closed"),
      "Unknown request tag: server.updateSettings",
      "hub.nodes.add: Unknown request tag: database.write",
      { code: -32601, message: "Other method not found" },
      Cause.die("hub.nodes.add failed"),
    ])
      expect(isHubNodesUnsupportedError(error)).toBe(false);
  });

  it("handles cyclic error wrappers", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(isHubNodesUnsupportedError(error)).toBe(false);
  });
});
