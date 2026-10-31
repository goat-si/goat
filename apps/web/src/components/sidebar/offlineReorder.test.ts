import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@goat/client-runtime/state/thread-sort";
import { planSidebarThreadDrop } from "../Sidebar.logic";
import { resolveSidebarReorderableThreadKeys } from "./reorderEligibility";
describe("reordering with cached offline configuration", () => {
  const onlineEnvironmentId = EnvironmentId.make("online");
  const offlineEnvironmentId = EnvironmentId.make("offline");
  const capabilities = {
    repositoryIdentity: true,
    threadPinning: true,
    threadPinReorder: true,
    threadActiveReorder: true,
  };
  const config = (environmentId: EnvironmentId) => ({
    environment: {
      environmentId,
      label: environmentId,
      platform: { os: "linux" as const, arch: "x64" as const },
      serverVersion: "0.1.1",
      capabilities,
    },
  });
  const serverConfigs = new Map([
    [onlineEnvironmentId, config(onlineEnvironmentId)],
    [offlineEnvironmentId, config(offlineEnvironmentId)],
  ]);
  const thread = (id: string, environmentId = onlineEnvironmentId, key: string | null = null) => ({
    id: ThreadId.make(id),
    environmentId,
    createdAt: `2026-03-09T${id === "offline" ? "12" : id === "online" ? "11" : "10"}:00:00.000Z`,
    activeOrderKey: key,
    pinOrderKey: key,
  });
  const keyOf = (entry: ReturnType<typeof thread>) =>
    scopedThreadKey(scopeThreadRef(entry.environmentId, entry.id));
  const online = thread("online");
  const offline = thread("offline", offlineEnvironmentId);
  const membership = (connectedEnvironmentIds = [onlineEnvironmentId]) =>
    resolveSidebarReorderableThreadKeys({
      threads: [online, offline],
      serverConfigs,
      connectedEnvironmentIds,
    });
  const planDrop = (input: {
    section: "active" | "pinned";
    rows: ReturnType<typeof thread>[];
    moved: ReturnType<typeof thread>;
    order: ReturnType<typeof thread>[];
    from?: "active" | "pinned";
    connectedEnvironmentIds?: EnvironmentId[];
  }) => {
    const writable = resolveSidebarReorderableThreadKeys({
      threads: input.rows,
      serverConfigs,
      connectedEnvironmentIds: input.connectedEnvironmentIds ?? [onlineEnvironmentId],
    });
    const sort = (rows: typeof input.rows) =>
      input.section === "active"
        ? sortActiveThreadsByOrderKey(rows)
        : sortPinnedThreadsByOrderKey(rows);
    const originalOrder = sort(input.rows).map(keyOf);
    const targetOrder = input.order.map(keyOf);
    const keysById = new Map(input.rows.map((entry) => [keyOf(entry), entry.activeOrderKey]));
    const plan = planSidebarThreadDrop({
      activeKey: keyOf(input.moved),
      activeSection: input.from ?? input.section,
      target: { section: input.section, pinnedOrder: targetOrder, activeOrder: targetOrder },
      pinnedOrder: originalOrder,
      activeOrder: originalOrder,
      pinnedKeysById: keysById,
      activeKeysById: keysById,
      reorderableKeys: writable.draggableThreadKeys,
      activeReorderableKeys: writable.activeReorderableThreadKeys,
    });
    const assignments =
      plan.kind === "move-active" || plan.kind === "reorder-pinned"
        ? plan.assignments
        : plan.kind === "pin"
          ? [
              ...plan.extraAssignments,
              ...(plan.orderKey === undefined
                ? []
                : [{ id: keyOf(input.moved), orderKey: plan.orderKey }]),
            ]
          : [];
    const assignedKeys = new Map(assignments.map(({ id, orderKey }) => [id, orderKey]));
    const actualOrder = sort(
      input.rows.map((entry) => ({
        ...entry,
        activeOrderKey: assignedKeys.get(keyOf(entry)) ?? entry.activeOrderKey,
        pinOrderKey: assignedKeys.get(keyOf(entry)) ?? entry.pinOrderKey,
      })),
    ).map(keyOf);

    return { plan, assignments, actualOrder, targetOrder };
  };

  it("excludes cached capable offline rows from both writable sets", () => {
    const writable = membership();

    expect([...writable.draggableThreadKeys]).toEqual([keyOf(online)]);
    expect([...writable.activeReorderableThreadKeys]).toEqual([keyOf(online)]);
    expect(serverConfigs.has(offlineEnvironmentId)).toBe(true);
  });

  it("updates membership through disconnect, reconnect, and missing configuration", () => {
    expect(membership([]).draggableThreadKeys.size).toBe(0);
    const connected = membership([onlineEnvironmentId, offlineEnvironmentId]);
    expect(connected.draggableThreadKeys.size).toBe(2);
    expect(connected.activeReorderableThreadKeys.size).toBe(2);

    const changed = resolveSidebarReorderableThreadKeys({
      threads: [online, offline],
      connectedEnvironmentIds: [onlineEnvironmentId, offlineEnvironmentId],
      serverConfigs: new Map([[onlineEnvironmentId, config(onlineEnvironmentId)]]),
    });
    expect([...changed.draggableThreadKeys]).toEqual([keyOf(online)]);
    expect([...changed.activeReorderableThreadKeys]).toEqual([keyOf(online)]);
  });

  it.each(["active", "pinned"] as const)("replans a disconnected drag source in %s", (section) => {
    const bound = thread("offline", offlineEnvironmentId, "m");
    const moved = thread("online", onlineEnvironmentId, "t");
    const input = { section, rows: [bound, moved], moved, order: [moved, bound] };
    expect(planDrop(input).plan.kind).toBe(section === "active" ? "move-active" : "reorder-pinned");

    const disconnected = planDrop({ ...input, connectedEnvironmentIds: [] });

    expect(disconnected.plan).toEqual({ kind: "none" });
    expect(disconnected.assignments).toEqual([]);
  });

  it.each(["active", "pinned"] as const)("preserves a keyed offline bound in %s", (section) => {
    const bound = thread("offline", offlineEnvironmentId, "m");
    const moved = thread("online", onlineEnvironmentId, "t");
    const result = planDrop({ section, rows: [bound, moved], moved, order: [moved, bound] });

    expect(result.plan.kind).toBe(section === "active" ? "move-active" : "reorder-pinned");
    expect(result.assignments.map(({ id }) => id)).toEqual([keyOf(moved)]);
    expect(result.actualOrder).toEqual(result.targetOrder);
  });

  it.each(["active", "pinned"] as const)(
    "rejects rebalancing a keyed offline bound in %s",
    (section) => {
      const bound = thread("offline", offlineEnvironmentId, "m");
      const neighbor = thread("neighbor");
      const result = planDrop({
        section,
        rows: [bound, online, neighbor],
        moved: online,
        order: [bound, neighbor, online],
      });

      expect(result.plan).toEqual({ kind: "none" });
      expect(result.assignments).toEqual([]);
    },
  );

  it.each(["active", "pinned"] as const)(
    "rejects crossing the frozen keyless boundary in %s",
    (section) => {
      const bound = {
        ...offline,
        createdAt: section === "active" ? "2026-03-09T12:00:00.000Z" : "2026-03-09T10:00:00.000Z",
      };
      const order = section === "active" ? [online, bound] : [bound, online];
      const result = planDrop({ section, rows: [bound, online], moved: online, order });

      expect(result.plan).toEqual({ kind: "none" });
      expect(result.assignments).toEqual([]);
    },
  );

  it.each(["active", "pinned"] as const)(
    "allows realizable moves beside a frozen keyless row in %s",
    (section) => {
      const neighbor = thread("neighbor");
      const order =
        section === "active" ? [offline, neighbor, online] : [online, neighbor, offline];
      const result = planDrop({
        section,
        rows: [offline, online, neighbor],
        moved: online,
        order,
      });

      expect(result.plan.kind).toBe(section === "active" ? "move-active" : "reorder-pinned");
      expect(result.assignments.length).toBeGreaterThan(0);
      expect(result.assignments.every(({ id }) => id !== keyOf(offline))).toBe(true);
      expect(result.actualOrder).toEqual(result.targetOrder);
    },
  );

  it.each(["active", "pinned"] as const)(
    "checks fallback assignments to other rows at the %s boundary",
    (section) => {
      const neighbor = thread("neighbor");
      const order =
        section === "active" ? [neighbor, offline, online] : [online, offline, neighbor];
      const result = planDrop({
        section,
        rows: [offline, online, neighbor],
        moved: online,
        order,
      });

      expect(result.plan).toEqual({ kind: "none" });
    },
  );

  it.each(["active", "pinned"] as const)(
    "rejects impossible pin/unpin placement across the %s boundary",
    (section) => {
      const order = section === "active" ? [online, offline] : [offline, online];
      const result = planDrop({
        section,
        rows: [offline, online],
        moved: online,
        order,
        from: section === "active" ? "pinned" : "active",
      });

      expect(result.plan).toEqual({ kind: "none" });
    },
  );
});
