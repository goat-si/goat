import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/rpc";
import { describe, expect, it } from "vite-plus/test";
import {
  disposableAliasRefusal,
  disposableRouteRefusal,
  hubDeviceAccess,
  hubNodeClassView,
  isHubNodesUnsupportedError,
} from "./hubNodes.ts";

describe("hubNodeClassView", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const machineClass = {
    class: "disposable",
    attachId: "a-1",
    state: "linked",
    stateSince: "2026-11-14T10:00:00.000Z",
    provisioner: { kind: "thread" as const, threadId: ThreadId.make("thread-1") },
    penMember: true,
    conflicts: [],
  };
  it("shows a disposable machine's class, Pen membership, provisioner, state and its age; a kept one shows nothing", () => {
    expect(hubNodeClassView(machineClass, now)).toEqual({
      badges: [
        { label: "Disposable", tone: "info" },
        { label: "Still in Pen", tone: "secondary" },
      ],
      detail: "Attached by an agent thread · linked for 2h",
    });
    expect(
      hubNodeClassView(
        {
          ...machineClass,
          class: "conflict",
          state: "left_pen",
          penMember: false,
          provisioner: { kind: "person" },
          conflicts: ["sshd_pin_shared", "other_route"],
        },
        now,
      ),
    ).toEqual({
      badges: [{ label: "Conflict", tone: "warning" }],
      detail:
        "Attached by a person · left Pen for 2h · Conflict: another record has the same SSH host key; the hub reaches it by another route than its Pen alias",
    });
    expect(hubNodeClassView(undefined, now)).toBeUndefined();
  });
});

describe("disposableRouteRefusal", () => {
  it("refuses another route to a saved environment the hub reaches as a disposable machine, and leaves a kept one alone", () => {
    const machineClass = {
      class: "disposable",
      attachId: "a-1",
      state: "linked",
      stateSince: "2026-11-14T10:00:00.000Z",
      provisioner: { kind: "person" as const },
      penMember: true,
      conflicts: [],
    };
    const nodes = [
      { environmentId: EnvironmentId.make("env-cc"), label: "cc-07", machineClass },
      { environmentId: EnvironmentId.make("env-box"), label: "box" },
    ];
    expect(disposableRouteRefusal(nodes, EnvironmentId.make("env-cc"))).toContain(
      "cc-07 is a disposable machine",
    );
    expect(disposableRouteRefusal(nodes, EnvironmentId.make("env-box"))).toBeUndefined();
  });
});

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
    expect(
      hubDeviceAccess({ ...base, hubEnabled: false, session: session(["orchestration:read"]) }),
    ).toBe("hub-off");
    // Turning the hub off leaves existing hub pairings working, so there is nothing to fix.
    expect(hubDeviceAccess({ ...base, hubEnabled: false, session: session(["hub:proxy"]) })).toBe(
      "ready",
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

describe("disposableAliasRefusal", () => {
  const machineClass = {
    class: "disposable",
    attachId: "a-1",
    state: "linked",
    stateSince: "2026-11-14T10:00:00.000Z",
    provisioner: { kind: "person" as const },
    penMember: true,
    conflicts: [],
  };
  const route = (alias: string) => ({
    routeId: "ssh:" + alias,
    source: "registered" as const,
    target: { kind: "ssh" as const, alias, hostname: null, username: null, port: null },
    status: "online" as const,
    checkedAt: null,
    lastSeenAt: null,
    lastError: null,
  });
  it("refuses an SSH connection to a host alias that is a disposable Hub device's route, compared as ssh does; a kept or ended one passes", () => {
    const nodes = [
      { label: "cc-07", routes: [route("pen-abc")], machineClass },
      { label: "box", routes: [route("box")] },
    ];
    for (const alias of ["pen-abc", "PEN-ABC", "pen-abc."])
      expect(disposableAliasRefusal(nodes, alias)).toContain("cc-07 is a disposable machine");
    expect(disposableAliasRefusal(nodes, "box")).toBeUndefined();
    // The hub projects no class once a record has ended.
    expect(
      disposableAliasRefusal([{ label: "cc-07", routes: [route("pen-abc")] }], "pen-abc"),
    ).toBeUndefined();
  });
});
