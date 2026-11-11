import { type EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import {
  isDecisionItemRemoved,
  isDecisionItemWaiting,
  type DecisionItem,
} from "./decisionInbox.ts";

import { a, b, ref, harness, approval, handoffItem } from "./decisionInbox.testkit.ts";

describe("decision inbox approval handoffs", () => {
  it("lists, counts and docks an open approval handoff from the feed until the feed drops it", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    try {
      h.registry.set(h.shells, []);
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      h.registry.set(h.feeds(b), { items: [], handoffs: [] });
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 1, total: 1 });
      const value = h.registry.get(h.inbox.itemsAtom);
      expect(value.items.map((entry) => [entry.kind, entry.routing.threadTitle])).toEqual([
        ["handoff", "Hub"],
      ]);
      expect(
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId),
      ).toEqual(["one"]);
      expect(h.registry.get(h.inbox.openApprovalsAtom(ref(b)))).toEqual([]);
      const id = value.items[0]!.id;
      h.registry.set(h.feeds(a), { items: [], handoffs: [] });
      expect(isDecisionItemRemoved(h.registry.get(h.inbox.itemsAtom), id)).toBe(true);
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 0, total: 0 });
      expect(h.registry.get(h.inbox.openApprovalsAtom(ref(a)))).toEqual([]);
    } finally {
      stopDock();
      stopItems();
      stopSummary();
      h.registry.dispose();
    }
  });

  it("docks a thread's loaded approval handoffs when its server's feed cannot list them", () => {
    const h = harness();
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    try {
      h.registry.set(h.feeds(a), { items: [] });
      h.set(ref(a), [], "live", null, [
        handoffItem(approval("loaded")),
        handoffItem({ ...approval("done"), state: "completed" }),
      ]);
      expect(
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId),
      ).toEqual(["loaded"]);
    } finally {
      stopDock();
      h.registry.dispose();
    }
  });
  it("keeps a feed approval waiting, not resolved, while its environment's feed is away", () => {
    const entry: DecisionItem = {
      id: JSON.stringify(["handoff", a, "one"]),
      ref: ref(a),
      createdAt: "2026-11-11T00:00:00.000Z",
      routing: { routedTo: "person" },
      kind: "handoff",
      handoff: approval("one"),
    };
    const snapshot = { feedEnvironments: [], loadingRefs: [], errors: [] };
    expect(isDecisionItemWaiting(snapshot, entry)).toBe(true);
    expect(isDecisionItemWaiting({ ...snapshot, feedEnvironments: [a] }, entry)).toBe(false);
  });
  it("keeps a known approval listed, counted and waiting while its environment disconnects, until its feed drops it", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    const phase = (environmentId: EnvironmentId, value: EnvironmentConnectionPhase) =>
      h.registry.set(h.presentations(environmentId), {
        ...h.registry.get(h.presentations(environmentId))!,
        connection: { phase: value, error: null, traceId: null },
      });
    try {
      h.registry.set(h.shells, []);
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      h.registry.set(h.feeds(b), { items: [], handoffs: [] });
      const id = h.registry.get(h.inbox.itemsAtom).items[0]!.id;

      phase(a, "reconnecting");
      const away = h.registry.get(h.inbox.itemsAtom);
      expect(away.items.map((entry) => entry.id)).toEqual([id]);
      expect(isDecisionItemRemoved(away, id)).toBe(false);
      expect(isDecisionItemWaiting(away, away.items[0]!)).toBe(true);
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 1, total: 1 });

      // Back, but its feed has not reloaded yet: still known, still waiting.
      h.registry.set(h.feeds(a), null);
      phase(a, "connected");
      expect(h.registry.get(h.inbox.itemsAtom).items.map((entry) => entry.id)).toEqual([id]);

      // An authoritative feed without it removes it.
      h.registry.set(h.feeds(a), { items: [], handoffs: [] });
      const settled = h.registry.get(h.inbox.itemsAtom);
      expect(settled.items).toEqual([]);
      expect(isDecisionItemRemoved(settled, id)).toBe(true);
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 0, total: 0 });
    } finally {
      stopItems();
      stopSummary();
      h.registry.dispose();
    }
  });
  it("keeps a thread's docked approvals, marked away, while its feed is gone or reloading", () => {
    const h = harness();
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    const stopAway = h.registry.mount(h.inbox.feedAwayAtom(a));
    try {
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      expect(h.registry.get(h.inbox.feedAwayAtom(a))).toBe(false);
      h.registry.set(h.presentations(a), {
        ...h.registry.get(h.presentations(a))!,
        connection: { phase: "offline", error: null, traceId: null },
      });
      h.registry.set(h.feeds(a), null);
      expect(
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId),
      ).toEqual(["one"]);
      expect(h.registry.get(h.inbox.feedAwayAtom(a))).toBe(true);
      h.registry.set(h.presentations(a), {
        ...h.registry.get(h.presentations(a))!,
        connection: { phase: "connected", error: null, traceId: null },
      });
      // Reconnected, feed still reloading: the card stays, still away.
      expect(
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId),
      ).toEqual(["one"]);
      expect(h.registry.get(h.inbox.feedAwayAtom(a))).toBe(true);
      h.registry.set(h.feeds(a), { items: [], handoffs: [] });
      expect(h.registry.get(h.inbox.openApprovalsAtom(ref(a)))).toEqual([]);
      expect(h.registry.get(h.inbox.feedAwayAtom(a))).toBe(false);
    } finally {
      stopAway();
      stopDock();
      stopItems();
      h.registry.dispose();
    }
  });
  it("keeps the docked list's identity when a feed update decodes the same approvals again", () => {
    const h = harness();
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    try {
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      const first = h.registry.get(h.inbox.openApprovalsAtom(ref(a)));
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      expect(h.registry.get(h.inbox.openApprovalsAtom(ref(a)))).toBe(first);
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: { ...approval("one"), state: "opened" } }],
      });
      expect(h.registry.get(h.inbox.openApprovalsAtom(ref(a)))).not.toBe(first);
    } finally {
      stopDock();
      h.registry.dispose();
    }
  });
  it("counts every open approval when the feed sends only the newest", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    try {
      h.registry.set(h.shells, []);
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
        handoffsTotal: 250,
      });
      h.registry.set(h.feeds(b), { items: [], handoffs: [] });
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 250, total: 250 });
    } finally {
      stopSummary();
      h.registry.dispose();
    }
  });
  it("keeps the dock's approvals on disconnect when the dock is the only subscriber", () => {
    const h = harness();
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    try {
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      expect(h.registry.get(h.inbox.openApprovalsAtom(ref(a)))).toHaveLength(1);
      h.registry.set(h.feeds(a), null);
      expect(
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId),
      ).toEqual(["one"]);
    } finally {
      stopDock();
      h.registry.dispose();
    }
  });

  it("counts a known approval once while its reconnected feed reloads", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    try {
      // The default shells wait on an approval in thread "thread" of each environment.
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      h.registry.set(h.feeds(b), { items: [], handoffs: [] });
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 1, total: 1 });
      h.registry.set(h.feeds(a), null);
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 1, total: 1 });
    } finally {
      stopSummary();
      h.registry.dispose();
    }
  });

  it("docks a thread's approval the capped feed left out, and the inbox says how many it cannot list", () => {
    const h = harness();
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    try {
      const newer = approval("newer");
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [
          {
            threadTitle: "Other",
            handoff: {
              ...newer,
              requestedBy: { ...newer.requestedBy, threadId: ThreadId.make("other") },
            },
          },
        ],
        handoffsTotal: 2,
      });
      h.registry.set(h.feeds(b), { items: [], handoffs: [] });
      h.set(ref(a), [], "live", null, [handoffItem(approval("older"))]);
      expect(
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId),
      ).toEqual(["older"]);
      expect(h.registry.get(h.inbox.itemsAtom).unlistedApprovals).toBe(1);
    } finally {
      stopDock();
      stopItems();
      h.registry.dispose();
    }
  });

  it("does not dock a cached approval the capped feed does not confirm until its thread is live", () => {
    const h = harness();
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    try {
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("listed") }],
        handoffsTotal: 201,
      });
      // Answered elsewhere while away; the cached projection still holds it.
      h.set(ref(a), [], "synchronizing", null, [handoffItem(approval("stale"))]);
      const docked = () =>
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId);
      expect(docked()).toEqual(["listed"]);
      h.set(ref(a), [], "cached", "Disconnected", [handoffItem(approval("stale"))]);
      expect(docked()).toEqual(["listed"]);
      h.set(ref(a), [], "live", null, [handoffItem(approval("older"))]);
      expect(docked()).toEqual(["older", "listed"]);
      // A server whose feed cannot list approvals relies on the thread alone, so it must be live too.
      h.registry.set(h.feeds(a), { items: [] });
      h.set(ref(a), [], "cached", "Disconnected", [handoffItem(approval("stale"))]);
      expect(docked()).toEqual([]);
    } finally {
      stopDock();
      h.registry.dispose();
    }
  });

  it("keeps a capped feed's approval docked when the thread's loaded history lacks it", () => {
    const h = harness();
    const stopDock = h.registry.mount(h.inbox.openApprovalsAtom(ref(a)));
    try {
      // A server that caps the feed but does not retain old handoffs in its snapshots.
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("listed") }],
        handoffsTotal: 201,
      });
      h.set(ref(a), [], "live", null, [handoffItem(approval("loaded"))]);
      expect(
        h.registry.get(h.inbox.openApprovalsAtom(ref(a))).map((entry) => entry.handoffId),
      ).toEqual(["loaded", "listed"]);
    } finally {
      stopDock();
      h.registry.dispose();
    }
  });

  it("forgets a remembered approval when it reconnects to a server whose feed cannot list approvals", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    try {
      h.registry.set(h.shells, []);
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      h.registry.set(h.feeds(b), { items: [], handoffs: [] });
      h.registry.set(h.presentations(a), {
        ...h.registry.get(h.presentations(a))!,
        connection: { phase: "offline", error: null, traceId: null },
      });
      expect(h.registry.get(h.inbox.itemsAtom).items).toHaveLength(1);
      // Back on a server whose feed has no handoffs field: nothing confirms the remembered card.
      h.registry.set(h.feeds(a), { items: [] });
      h.registry.set(h.presentations(a), {
        ...h.registry.get(h.presentations(a))!,
        connection: { phase: "connected", error: null, traceId: null },
      });
      expect(h.registry.get(h.inbox.itemsAtom).items).toEqual([]);
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 0, total: 0 });
    } finally {
      stopItems();
      stopSummary();
      h.registry.dispose();
    }
  });

  it("treats an approval as removed, not waiting, once its environment leaves the catalog", () => {
    const h = harness();
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    try {
      h.registry.set(h.feeds(a), {
        items: [],
        handoffs: [{ threadTitle: "Hub", handoff: approval("one") }],
      });
      h.registry.set(h.feeds(b), { items: [], handoffs: [] });
      const entry = h.registry.get(h.inbox.itemsAtom).items[0]!;
      const catalog = h.registry.get(h.catalog);
      h.registry.set(h.catalog, {
        ...catalog,
        entries: new Map([...catalog.entries].filter(([id]) => id !== a)),
      });
      const after = h.registry.get(h.inbox.itemsAtom);
      expect(after.items).toEqual([]);
      expect(isDecisionItemWaiting(after, entry)).toBe(false);
      expect(isDecisionItemRemoved(after, entry.id)).toBe(true);
    } finally {
      stopItems();
      h.registry.dispose();
    }
  });
});
