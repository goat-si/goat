import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  HubNode,
  HubNodesError,
  HubNodesImportInput,
  HubNodeRouteTarget,
  HubNodesSnapshot,
} from "./hubNodes.ts";

const decodeNode = Schema.decodeUnknownExit(HubNode);
const decodeTarget = Schema.decodeUnknownSync(HubNodeRouteTarget);
const encodeTarget = Schema.encodeSync(HubNodeRouteTarget);
const decodeImport = Schema.decodeUnknownExit(HubNodesImportInput);
const decodeSnapshot = Schema.decodeUnknownSync(HubNodesSnapshot);

const route = {
  routeId: "ssh:epyc",
  source: "registered",
  target: { kind: "ssh", alias: "epyc", hostname: null, username: null, port: null },
  status: "unknown",
  checkedAt: null,
  lastSeenAt: null,
  lastError: null,
};

describe("HubNode", () => {
  it("requires at least one route", () => {
    const base = {
      nodeId: "env-1",
      environmentId: "env-1",
      label: "epyc",
      kind: "ssh",
      status: "unknown",
      lastSeenAt: null,
      addedBy: null,
    };
    expect(decodeNode({ ...base, routes: [route] })._tag).toBe("Success");
    expect(decodeNode({ ...base, routes: [] })._tag).toBe("Failure");
  });

  it("keeps linked-host metadata and has no token field", () => {
    const linked = {
      kind: "linked",
      name: "studio",
      baseUrl: "https://studio.example.ts.net",
      access: "full-access",
      expiresAt: "2026-11-18T00:00:00.000Z",
      token: "must-not-survive",
    };
    const decoded = decodeTarget(linked);
    expect(decoded).not.toHaveProperty("token");
    expect(encodeTarget(decoded)).toEqual({
      kind: "linked",
      name: "studio",
      baseUrl: "https://studio.example.ts.net",
      access: "full-access",
      expiresAt: "2026-11-18T00:00:00.000Z",
    });
  });
});

describe("HubNodesSnapshot", () => {
  const node = (routes: ReadonlyArray<unknown>) => ({
    nodeId: "env-1",
    environmentId: "env-1",
    label: "epyc",
    kind: "ssh",
    status: "unknown",
    lastSeenAt: null,
    addedBy: null,
    routes,
  });
  const futureRoute = { ...route, routeId: "relay:x", target: { kind: "relay", id: "x" } };

  it("drops nodes and notices a newer hub adds, keeping the rest", () => {
    const decoded = decodeSnapshot({
      hubEnvironmentId: "env-hub",
      nodes: [node([route]), node([route, futureRoute])],
      notices: [
        { id: "desktop-import-locked", at: "2026-10-19T00:00:00.000Z" },
        { id: "something-new", at: "2026-10-19T00:00:00.000Z" },
      ],
    });
    expect(decoded.nodes).toHaveLength(1);
    expect(decoded.nodes[0]?.routes).toHaveLength(1);
    expect(decoded.notices.map((notice) => notice.id)).toEqual(["desktop-import-locked"]);
  });
});

describe("HubNodesImportInput", () => {
  it("accepts a locked catalog without profiles and caps readable profiles", () => {
    expect(decodeImport({ source: "desktop-catalog", catalog: { state: "locked" } })._tag).toBe(
      "Success",
    );
    const profile = {
      environmentId: "env-2",
      label: "laptop",
      ssh: { alias: "laptop", hostname: null, username: null, port: null },
    };
    const many = Array.from({ length: 501 }, () => profile);
    expect(
      decodeImport({ source: "desktop-catalog", catalog: { state: "readable", profiles: many } })
        ._tag,
    ).toBe("Failure");
  });
});

describe("HubNodesError", () => {
  it("shows its detail as the message", () => {
    expect(new HubNodesError({ reason: "refused", detail: "Cloud routes stay." }).message).toBe(
      "Cloud routes stay.",
    );
  });
});
