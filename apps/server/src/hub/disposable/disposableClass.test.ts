import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type HubNode } from "@goat/contracts";

import {
  type DisposableRecord,
  disposableActionAllowed,
  disposableClasses,
} from "./disposableClass.ts";

const NODE_A = "a".repeat(26);
const NODE_B = "b".repeat(26);
const record = (overrides: Partial<DisposableRecord> & Pick<DisposableRecord, "attachId">) =>
  ({
    nodeId: NODE_A,
    state: "attached",
    stateSince: "2026-11-13T00:00:00.000Z",
    createdAt: "2026-11-13T00:00:00.000Z",
    provisioner: { kind: "thread", threadId: "thread-1" },
    final: false,
    environmentId: "env-a",
    machineInstallId: "install-a",
    sshdPin: "SHA256:pin-a",
    linkId: "lnk_a",
    conflicts: [],
    penMember: true,
    ...overrides,
  }) as DisposableRecord;
const ssh = (alias: string, overrides: Partial<{ hostname: string; port: number }> = {}) =>
  ({
    routeId: "ssh:" + alias,
    source: "registered",
    target: { kind: "ssh", alias, hostname: null, username: null, port: null, ...overrides },
    status: "online",
    checkedAt: null,
    lastSeenAt: null,
    lastError: null,
  }) as HubNode["routes"][number];
const node = (environmentId: string | null, routes: HubNode["routes"]) => ({
  environmentId: environmentId === null ? null : EnvironmentId.make(environmentId),
  routes,
});

describe("disposable machine class", () => {
  it("is absent for a machine no record matches, so it reads kept", () => {
    const classes = disposableClasses([record({ attachId: "a1" })]);
    expect(classes.forNode(node("env-other", [ssh("cc-01")]))).toBeUndefined();
    expect(disposableClasses([]).forNode(node("env-a", [ssh("pen-" + NODE_A)]))).toBeUndefined();
  });

  it("is disposable for the record's own Pen alias and environment", () => {
    const classes = disposableClasses([record({ attachId: "a1" })]);
    expect(classes.forNode(node("env-a", [ssh("pen-" + NODE_A)]))).toEqual({
      class: "disposable",
      attachId: "a1",
      state: "attached",
      stateSince: "2026-11-13T00:00:00.000Z",
      provisioner: { kind: "thread", threadId: "thread-1" },
      penMember: true,
      conflicts: [],
    });
  });

  it("two records with one sshd pin or install id are both conflicts and block every automatic action", () => {
    for (const shared of [{ sshdPin: "SHA256:pin-a" }, { machineInstallId: "install-a" }]) {
      const records = [
        record({ attachId: "a1" }),
        record({
          attachId: "a2",
          nodeId: NODE_B,
          environmentId: "env-b",
          machineInstallId: "install-b",
          sshdPin: "SHA256:pin-b",
          linkId: "lnk_b",
          ...shared,
        }),
      ];
      const classes = disposableClasses(records);
      for (const [attachId, environmentId, alias] of [
        ["a1", "env-a", "pen-" + NODE_A],
        ["a2", "env-b", "pen-" + NODE_B],
      ] as const) {
        expect(classes.forNode(node(environmentId, [ssh(alias)]))?.class).toBe("conflict");
        const own = records.find((entry) => entry.attachId === attachId);
        expect(
          own && disposableActionAllowed(own, environmentId, classes.conflictsOf(attachId)),
        ).toBe(false);
      }
    }
  });

  it("a record in a final state shares nothing", () => {
    const classes = disposableClasses([
      record({ attachId: "a1" }),
      record({ attachId: "a0", nodeId: NODE_B, final: true, state: "purged" }),
    ]);
    expect(classes.conflictsOf("a1")).toEqual([]);
    expect(classes.forNode(node("env-a", [ssh("pen-" + NODE_A)]))?.class).toBe("disposable");
  });

  it("another route to the machine, or a changed environment, is a conflict", () => {
    const classes = disposableClasses([record({ attachId: "a1" })]);
    expect(classes.forNode(node("env-a", [ssh("cc-04"), ssh("pen-" + NODE_A)]))?.conflicts).toEqual(
      ["other_route"],
    );
    expect(
      classes.forNode(node("env-a", [ssh("pen-" + NODE_A, { hostname: "10.0.0.4" })]))?.conflicts,
    ).toEqual(["other_route"]);
    expect(classes.forNode(node("env-z", [ssh("pen-" + NODE_A)]))?.conflicts).toEqual([
      "environment_changed",
    ]);
  });

  it("an automatic action needs the record's own environment and no conflict", () => {
    const own = record({ attachId: "a1" });
    expect(disposableActionAllowed(own, "env-a", [])).toBe(true);
    expect(disposableActionAllowed(own, "env-b", [])).toBe(false);
    expect(disposableActionAllowed({ ...own, environmentId: null }, null, [])).toBe(false);
    expect(disposableActionAllowed({ ...own, final: true }, "env-a", [])).toBe(false);
    expect(disposableActionAllowed(own, "env-a", ["pin_changed"])).toBe(false);
  });
});
