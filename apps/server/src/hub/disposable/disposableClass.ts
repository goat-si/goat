import type { DisposableMachineProvisioner, HubNode, HubNodeMachineClass } from "@goat/contracts";

/** A disposable_machines row as the class rules read it. */
export interface DisposableRecord {
  readonly attachId: string;
  readonly nodeId: string;
  readonly state: string;
  readonly stateSince: string;
  readonly createdAt: string;
  readonly provisioner: DisposableMachineProvisioner;
  readonly final: boolean;
  readonly environmentId: string | null;
  readonly machineInstallId: string | null;
  readonly sshdPin: string | null;
  readonly linkId: string | null;
  /** Conflicts a check recorded, such as a changed pin or a replaced link. */
  readonly conflicts: ReadonlyArray<string>;
  readonly penMember: boolean;
}

// Values no two open records may share: a shared one is a cloned VM or a reused link.
const UNIQUE = [
  ["sshdPin", "sshd_pin_shared"],
  ["environmentId", "environment_shared"],
  ["machineInstallId", "install_shared"],
  ["linkId", "link_shared"],
] as const;

const ownRoute = (record: DisposableRecord, route: HubNode["routes"][number]) =>
  route.target.kind === "ssh" &&
  route.target.alias === `pen-${record.nodeId}` &&
  route.target.hostname === null &&
  route.target.username === null &&
  route.target.port === null;

/**
 * The class rules over every record. A node no open record matches is kept; one that matches is
 * disposable, or conflict when anything about it is ambiguous.
 */
export const disposableClasses = (records: ReadonlyArray<DisposableRecord>) => {
  const open = records
    .filter((record) => !record.final)
    .toSorted(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.attachId.localeCompare(b.attachId),
    );
  const conflicts = new Map(open.map((record) => [record.attachId, [...record.conflicts]]));
  for (const [field, reason] of UNIQUE) {
    const holders = new Map<string, Array<string>>();
    for (const record of open) {
      const value = record[field];
      if (value !== null) holders.set(value, [...(holders.get(value) ?? []), record.attachId]);
    }
    for (const attachIds of holders.values())
      if (attachIds.length > 1) for (const id of attachIds) conflicts.get(id)?.push(reason);
  }
  const conflictsOf = (attachId: string): ReadonlyArray<string> => conflicts.get(attachId) ?? [];

  const forNode = (
    node: Pick<HubNode, "environmentId" | "routes">,
  ): HubNodeMachineClass | undefined => {
    const matches = open.filter(
      (record) =>
        node.routes.some((route) => ownRoute(record, route)) ||
        (record.environmentId !== null && record.environmentId === node.environmentId),
    );
    const [record] = matches;
    if (record === undefined) return undefined;
    const reasons = [
      ...conflictsOf(record.attachId),
      ...(matches.length > 1 ? ["several_records"] : []),
      ...(node.routes.some((route) => !ownRoute(record, route)) ? ["other_route"] : []),
      ...(record.environmentId !== null &&
      node.environmentId !== null &&
      record.environmentId !== node.environmentId
        ? ["environment_changed"]
        : []),
    ];
    return {
      class: reasons.length === 0 ? "disposable" : "conflict",
      attachId: record.attachId,
      state: record.state,
      stateSince: record.stateSince,
      provisioner: record.provisioner,
      penMember: record.penMember,
      conflicts: [...new Set(reasons)].slice(0, 16),
    };
  };
  /**
   * Whether GOAT may act on the record's machine without a person (retire, compensate, detach as
   * the system): the machine as observed now, its environment and routes, projects as this record
   * with no conflict. Anything less is treated as kept.
   */
  const actionAllowed = (
    record: DisposableRecord,
    observed: Pick<HubNode, "environmentId" | "routes">,
  ) => {
    const projected = forNode(observed);
    return (
      !record.final &&
      record.environmentId !== null &&
      record.environmentId === observed.environmentId &&
      projected?.attachId === record.attachId &&
      projected.class === "disposable"
    );
  };
  return { forNode, actionAllowed };
};
