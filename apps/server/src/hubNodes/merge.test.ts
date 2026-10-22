import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import type { LinkedHost } from "../linkedHosts/LinkedHosts.ts";
import type { Registration, RouteState } from "./HubNodeRepository.ts";
import { mergeHubNodes } from "./merge.ts";

const hub = EnvironmentId.make("env-hub");
const remote = EnvironmentId.make("env-remote");
const at = "2026-10-19T00:00:00.000Z";
const later = "2026-10-20T00:00:00.000Z";
const registration = (
  alias = "box",
  environmentId: EnvironmentId | null = remote,
): Registration => ({
  routeId: `ssh:${alias}`,
  environmentId,
  label: "Registered",
  target: { kind: "ssh", alias, hostname: null, username: null, port: null },
  addedBy: { kind: "user", at },
  createdAt: at,
  updatedAt: at,
});
const link: LinkedHost = {
  name: "linked",
  baseUrl: "https://box.example",
  environmentId: remote,
  label: "Linked",
  serverVersion: "test",
  access: "read-only",
  linkedAt: at,
  expiresAt: later,
};
const state = (
  routeId: string,
  status: RouteState["status"],
  lastSeenAt: string | null = null,
): RouteState => ({
  routeId,
  environmentId: remote,
  status,
  checkedAt: at,
  lastSeenAt,
  lastError: null,
});
const merge = (input: Partial<Parameters<typeof mergeHubNodes>[0]> = {}) =>
  mergeHubNodes({
    hubEnvironmentId: hub,
    registrations: [],
    linked: [],
    cloud: [],
    routeState: [],
    notices: [],
    ...input,
  });

describe("mergeHubNodes", () => {
  it("deduplicates identity, orders routes, and exposes linked access without credentials", () => {
    const snapshot = merge({
      registrations: [registration()],
      linked: [link],
      cloud: [{ alias: "boat-bx_23456789", label: "Cloud" }],
      routeState: [
        state("cloud:boat-bx_23456789", "offline"),
        state("ssh:box", "offline", at),
        state("linked:linked", "online", later),
      ],
    });
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({
      nodeId: remote,
      label: "Registered",
      kind: "ssh",
      status: "online",
      lastSeenAt: later,
      addedBy: { kind: "user", at },
    });
    expect(snapshot.nodes[0]!.routes.map((route) => route.routeId)).toEqual([
      "ssh:box",
      "linked:linked",
      "cloud:boat-bx_23456789",
    ]);
    expect(snapshot.nodes[0]!.routes[1]!.target).toEqual({
      kind: "linked",
      name: link.name,
      baseUrl: link.baseUrl,
      access: link.access,
      expiresAt: link.expiresAt,
    });
    expect(JSON.stringify(snapshot)).not.toContain('"token"');
  });
  it("drops hub identity and retains separate route ids for unidentified hosts", () => {
    expect(
      merge({
        registrations: [
          registration("self", hub),
          registration("a", null),
          registration("b", null),
        ],
      }).nodes.map((node) => node.nodeId),
    ).toEqual(["route:ssh:a", "route:ssh:b"]);
  });
  it("requires every route to be checked and offline before aggregating offline", () => {
    expect(
      merge({
        registrations: [registration()],
        linked: [link],
        routeState: [state("ssh:box", "offline")],
      }).nodes[0]!.status,
    ).toBe("unknown");
    expect(
      merge({
        registrations: [registration()],
        linked: [link],
        routeState: [state("ssh:box", "offline"), state("linked:linked", "offline")],
      }).nodes[0]!.status,
    ).toBe("offline");
    expect(
      merge({
        registrations: [registration()],
        routeState: [{ ...state("ssh:box", "offline"), checkedAt: null }],
      }).nodes[0]!.status,
    ).toBe("unknown");
  });
  it("uses source label priority and earliest registration attribution deterministically", () => {
    const earliest = {
      ...registration("z"),
      createdAt: "2026-10-18T00:00:00.000Z",
      addedBy: { kind: "agent" as const, at },
    };
    expect(
      merge({ registrations: [earliest, { ...registration("a"), label: null }], linked: [link] })
        .nodes[0],
    ).toMatchObject({ label: "Registered", addedBy: earliest.addedBy });
    expect(
      merge({ registrations: [{ ...registration(), label: null }], linked: [link] }).nodes[0]!
        .label,
    ).toBe("Linked");
    expect(merge({ registrations: [{ ...registration(), label: null }] }).nodes[0]!.label).toBe(
      "box",
    );
  });
  it("sorts labels then node ids independently of input order", () => {
    const rows = [
      registration("b", EnvironmentId.make("env-z")),
      registration("a", EnvironmentId.make("env-a")),
    ];
    expect(merge({ registrations: rows }).nodes.map((node) => node.nodeId)).toEqual([
      "env-a",
      "env-z",
    ]);
    expect(merge({ registrations: rows.toReversed() })).toEqual(merge({ registrations: rows }));
  });
});

it("uses the current link identity when a name is relinked to another environment", () => {
  const snapshot = merge({
    linked: [{ ...link, environmentId: "env-replacement" }],
    routeState: [state("linked:linked", "online", at)],
  });
  expect(snapshot.nodes[0]).toMatchObject({
    nodeId: "env-replacement",
    status: "unknown",
    lastSeenAt: null,
  });
});
