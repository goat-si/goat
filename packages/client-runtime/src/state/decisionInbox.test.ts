import {
  type DecisionFeed,
  type DecisionItem as DurableDecision,
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "../connection/presentation.ts";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import {
  createDecisionInboxAtoms,
  isDecisionItemRemoved,
  orderDecisionQueue,
  skipDecisionItem,
  type DecisionItem,
} from "./decisionInbox.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { threadKey } from "./entities.ts";
import { presentThreadShell } from "./models.ts";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const ref = (environmentId = a, id = "thread") => ({ environmentId, threadId: ThreadId.make(id) });
const shell = (scope: ScopedThreadRef, overrides: Partial<typeof v2ThreadShell> = {}) =>
  presentThreadShell(scope.environmentId, {
    ...v2ThreadShell,
    id: scope.threadId,
    pendingRuntimeRequest: { id: RuntimeRequestId.make("flag"), kind: "command", createdAt: v2Now },
    ...overrides,
  });
const request = (
  id: string,
  createdAt: string,
): OrchestrationV2ThreadProjection["runtimeRequests"][number] => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make("node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "not_resumable", reason: "Provider session cannot be resumed" },
  createdAt: DateTime.makeUnsafe(createdAt),
  resolvedAt: null,
});
function harness() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const entries = new Map(
    [a, b].map((environmentId) => [
      environmentId,
      {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        }),
        profile: Option.none(),
        enabled: true,
      },
    ]),
  );
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: true, entries });
  const presentations = Atom.family((id: EnvironmentId) =>
    Atom.make<EnvironmentPresentation | null>({
      entry: entries.get(id)!,
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: null,
    }),
  );
  const shells = Atom.make([shell(ref(a)), shell(ref(b))]);
  const data = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(Atom.keepAlive),
  );
  const activeSources = new Set<string>();
  const sourceReads = new Map<string, number>();
  const sources = Atom.family((key: string) =>
    Atom.make((get) => {
      activeSources.add(key);
      sourceReads.set(key, (sourceReads.get(key) ?? 0) + 1);
      get.addFinalizer(() => activeSources.delete(key));
      return get(data(key));
    }).pipe(Atom.setIdleTTL(0)),
  );
  const details = createEnvironmentThreadDetailAtoms((env, thread) =>
    sources(threadKey({ environmentId: env, threadId: thread })),
  );
  let detailReads = 0;
  const feeds = Atom.family((_id: EnvironmentId) => Atom.make<DecisionFeed | null>(null));
  const inbox = createDecisionInboxAtoms({
    catalogValueAtom: catalog,
    threadShellsAtom: shells,
    presentationAtom: presentations,
    feedAtom: feeds,
    details: {
      ...details,
      pendingRequestsAtom: (scope) => {
        detailReads += 1;
        return details.pendingRequestsAtom(scope);
      },
    },
  });
  const set = (
    scope: ScopedThreadRef,
    requests: OrchestrationV2ThreadProjection["runtimeRequests"],
    status: EnvironmentThreadState["status"] = "live",
    error: string | null = null,
    turnItems: OrchestrationV2ThreadProjection["turnItems"] = [],
  ) =>
    registry.set(
      data(threadKey(scope)),
      AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        status,
        error: Option.fromNullOr(error),
        data:
          status === "deleted"
            ? Option.none()
            : Option.some({
                ...v2Projection,
                thread: { ...v2Projection.thread, id: scope.threadId },
                runtimeRequests: requests,
                turnItems,
              }),
      }),
    );
  return {
    registry,
    catalog,
    presentations,
    shells,
    inbox,
    feeds,
    details,
    set,
    flush,
    activeSources,
    sourceReads,
    detailReads: () => detailReads,
  };
}
const requestOf = (entry: DecisionItem) => {
  if (entry.kind === "decision") throw new Error("Expected a thread request");
  return entry.request;
};
const item = (id: string, createdAt: string): DecisionItem => ({
  id,
  createdAt,
  ref: ref(),
  routing: { routedTo: "person" },
  kind: "approval",
  request: {
    requestId: RuntimeRequestId.make(id),
    requestKind: "command",
    createdAt,
    responseCapability: "live",
  },
});

const questionItem: OrchestrationV2ThreadProjection["turnItems"][number] = {
  id: TurnItemId.make("inbox-question-item"),
  threadId: ref(a).threadId,
  runId: null,
  nodeId: NodeId.make("node"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
  type: "user_input_request",
  requestId: RuntimeRequestId.make("question"),
  responseMode: "message",
  questions: [
    {
      id: "next",
      header: "Next",
      question: "What should happen next?",
      required: true,
      allowCustomAnswer: false,
      multiSelect: false,
      options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
    },
  ],
};
const nonconnectedPhases: ReadonlyArray<EnvironmentConnectionPhase | null> = [
  "available",
  "offline",
  "connecting",
  "reconnecting",
  "error",
  "unsupported",
  null,
];

describe("decision inbox", () => {
  it("orders oldest first with a deterministic id tie-break and never mutates input", () => {
    const items = [
      item("z", "2026-10-13T02:00:00.000Z"),
      item("b", "2026-10-13T01:00:00.000Z"),
      item("a", "2026-10-13T01:00:00.000Z"),
    ];
    expect(orderDecisionQueue(items, []).map((entry) => entry.id)).toEqual(["a", "b", "z"]);
    expect(items.map((entry) => entry.id)).toEqual(["z", "b", "a"]);
  });
  it("moves skips behind new work, preserves skip sequence, and prunes departed ids", () => {
    const items = [item("a", "1"), item("b", "2"), item("c", "3")];
    let skips = skipDecisionItem(items, [], "a");
    skips = skipDecisionItem(items, skips, "b");
    expect(orderDecisionQueue(items, skips).map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    expect(skipDecisionItem(items, ["gone", "a", "a", "b"], "a")).toEqual(["b", "a"]);
    expect(skipDecisionItem([], skips, "a")).toEqual([]);
    expect(skipDecisionItem(items, skips, "unknown")).toEqual(["a", "b"]);
    expect(orderDecisionQueue([items[0]!], ["a"]).map((entry) => entry.id)).toEqual(["a"]);
  });
  it("keeps summary cheap and corrects stale flags after live detail loads", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    const before = h.registry.get(h.inbox.summaryAtom);
    expect(before.count).toBe(2);
    expect(h.detailReads()).toBe(0);
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    try {
      expect(h.registry.get(h.inbox.itemsAtom).isLoading).toBe(true);
      h.set(ref(a), []);
      h.set(ref(b), []);
      expect(h.registry.get(h.inbox.itemsAtom)).toEqual({
        items: [],
        authoritativeRefs: [ref(a), ref(b)],
        feedEnvironments: [],
        loadingRefs: [],
        errors: [],
        isLoading: false,
      });
      expect(h.registry.get(h.inbox.summaryAtom)).toBe(before);
    } finally {
      stopItems();
      stopSummary();
      h.registry.dispose();
    }
  });
  it("scopes identical thread/request ids by enabled connected environment", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    try {
      h.set(ref(a), [request("same", "2026-10-13T01:00:00Z")]);
      h.set(ref(b), [request("same", "2026-10-13T00:00:00Z")]);
      expect(h.registry.get(h.inbox.itemsAtom).items.map((entry) => entry.id)).toEqual([
        JSON.stringify(["b", "thread", "same"]),
        JSON.stringify(["a", "thread", "same"]),
      ]);
      const previous = h.registry.get(h.presentations(b))!;
      h.registry.set(h.presentations(b), {
        ...previous,
        connection: { phase: "reconnecting", error: null, traceId: null },
      });
      expect(h.registry.get(h.inbox.summaryAtom).count).toBe(1);
      expect(
        h.registry.get(h.inbox.itemsAtom).items.map((entry) => entry.ref.environmentId),
      ).toEqual([a]);
      h.registry.set(h.presentations(b), previous);
      const current = h.registry.get(h.catalog);
      h.registry.set(h.catalog, {
        ...current,
        entries: new Map(
          [...current.entries].map(([id, entry]) => [
            id,
            id === b ? { ...entry, enabled: false } : entry,
          ]),
        ),
      });
      expect(h.registry.get(h.inbox.summaryAtom).count).toBe(1);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
  it("requires connected live detail before removing retained decision state", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    const id = JSON.stringify([a, ref(a).threadId, "retained"]);
    try {
      h.set(ref(a), [request("retained", "2026-10-13T00:00:00Z")]);
      h.set(ref(b), []);
      expect(isDecisionItemRemoved(h.registry.get(h.inbox.itemsAtom), id)).toBe(false);
      const connected = h.registry.get(h.presentations(a))!;
      h.registry.set(h.presentations(a), {
        ...connected,
        connection: { phase: "reconnecting", error: null, traceId: null },
      });
      let snapshot = h.registry.get(h.inbox.itemsAtom);
      expect(snapshot.items).toEqual([]);
      expect(snapshot.authoritativeRefs).toEqual([ref(b)]);
      expect(isDecisionItemRemoved(snapshot, id)).toBe(false);
      h.set(ref(a), [], "cached");
      h.registry.set(h.presentations(a), connected);
      snapshot = h.registry.get(h.inbox.itemsAtom);
      expect(snapshot.isLoading).toBe(true);
      expect(isDecisionItemRemoved(snapshot, id)).toBe(false);
      h.set(ref(a), [], "synchronizing");
      expect(isDecisionItemRemoved(h.registry.get(h.inbox.itemsAtom), id)).toBe(false);
      h.set(ref(a), [], "live", "Could not synchronize.");
      expect(isDecisionItemRemoved(h.registry.get(h.inbox.itemsAtom), id)).toBe(false);
      h.set(ref(a), [request("retained", "2026-10-13T00:00:00Z")]);
      expect(isDecisionItemRemoved(h.registry.get(h.inbox.itemsAtom), id)).toBe(false);
      // Another environment still loading does not prevent authoritative removal here.
      h.set(ref(b), [], "synchronizing");
      h.set(ref(a), []);
      snapshot = h.registry.get(h.inbox.itemsAtom);
      expect(snapshot.authoritativeRefs).toEqual([ref(a)]);
      expect(isDecisionItemRemoved(snapshot, id)).toBe(true);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
  it("aggregates partial loading and errors without dropping healthy or nonresumable items", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    try {
      h.set(ref(a), [request("retained", "2026-10-13T00:00:00Z")]);
      let value = h.registry.get(h.inbox.itemsAtom);
      expect(value.isLoading).toBe(true);
      expect(value.items).toHaveLength(1);
      expect(requestOf(value.items[0]!).responseCapability).toBe("not_resumable");
      h.set(ref(b), [], "synchronizing", "Could not load thread.");
      value = h.registry.get(h.inbox.itemsAtom);
      expect(value.isLoading).toBe(false);
      expect(value.errors).toEqual([{ ref: ref(b), message: "Could not load thread." }]);
      expect(value.items).toHaveLength(1);
      h.set(ref(b), [], "deleted");
      expect(h.registry.get(h.inbox.itemsAtom).errors).toEqual([]);
      h.set(ref(a), []);
      expect(h.registry.get(h.inbox.itemsAtom).items).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
  it("includes active subagent shells and excludes disconnected or disabled environments", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    try {
      h.registry.set(h.shells, [
        shell(ref(a), {
          creationSource: "provider",
          lineage: {
            rootThreadId: ThreadId.make("root"),
            parentThreadId: ThreadId.make("root"),
            relationshipToParent: "subagent",
          },
        }),
        shell(ref(b)),
      ]);
      h.set(ref(a), [request("subagent", "2026-10-13T00:00:00Z")]);
      h.set(ref(b), [request("other", "2026-10-13T00:01:00Z")]);
      expect(h.registry.get(h.inbox.summaryAtom).count).toBe(2);
      expect(h.registry.get(h.inbox.itemsAtom).items.map((item) => item.ref)).toEqual([
        ref(a),
        ref(b),
      ]);
      const connected = h.registry.get(h.presentations(b))!;
      h.registry.set(h.presentations(b), {
        ...connected,
        connection: { phase: "offline", error: null, traceId: null },
      });
      expect(h.registry.get(h.inbox.summaryAtom).refs).toEqual([ref(a)]);
      expect(h.registry.get(h.inbox.itemsAtom).items.map((item) => item.ref)).toEqual([ref(a)]);
      h.registry.set(h.presentations(b), connected);
      const catalog = h.registry.get(h.catalog);
      h.registry.set(h.catalog, {
        ...catalog,
        entries: new Map(
          [...catalog.entries].map(([id, entry]) => [
            id,
            id === b ? { ...entry, enabled: false } : entry,
          ]),
        ),
      });
      expect(h.registry.get(h.inbox.summaryAtom).refs).toEqual([ref(a)]);
      expect(h.registry.get(h.inbox.itemsAtom).items.map((item) => item.ref)).toEqual([ref(a)]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("derives eligible request bodies while counting flagged threads provisionally", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    try {
      h.set(
        ref(a),
        [
          request("approval-one", "2026-10-13T00:00:00Z"),
          request("approval-two", "2026-10-13T00:01:00Z"),
          {
            ...request("question", "2026-10-13T00:02:00Z"),
            kind: "user_input",
            responseCapability: { type: "message" },
          },
          { ...request("auth", "2026-10-13T00:03:00Z"), kind: "auth_refresh" },
          { ...request("tool", "2026-10-13T00:04:00Z"), kind: "dynamic_tool_call" },
        ],
        "live",
        null,
        [questionItem],
      );
      h.set(ref(b), []);
      const value = h.registry.get(h.inbox.itemsAtom);
      expect(h.registry.get(h.inbox.summaryAtom).count).toBe(2);
      expect(value.items.map((entry) => [entry.kind, requestOf(entry).requestId])).toEqual([
        ["approval", "approval-one"],
        ["approval", "approval-two"],
        ["user_input", "question"],
      ]);
      expect(requestOf(value.items[2]!)).toEqual({
        requestId: "question",
        createdAt: "2026-10-13T00:02:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      });
      expect(requestOf(value.items[2]!)).toBe(
        h.registry.get(h.details.pendingRequestsAtom(ref(a)))?.userInputs[0],
      );
      h.set(ref(a), [
        { ...request("auth", "2026-10-13T00:03:00Z"), kind: "auth_refresh" },
        { ...request("tool", "2026-10-13T00:04:00Z"), kind: "dynamic_tool_call" },
      ]);
      expect(h.registry.get(h.inbox.itemsAtom)).toEqual({
        items: [],
        authoritativeRefs: [ref(a), ref(b)],
        feedEnvironments: [],
        loadingRefs: [],
        errors: [],
        isLoading: false,
      });
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("reuses summary references across shell churn, deduplicates refs, and releases unflagged details", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    try {
      const before = h.registry.get(h.inbox.summaryAtom);
      h.registry.set(h.shells, [
        shell(ref(b)),
        shell(ref(a), { title: "Changed", status: "running" }),
        shell(ref(a)),
      ]);
      expect(h.registry.get(h.inbox.summaryAtom)).toBe(before);
      expect(before.count).toBe(2);
      h.registry.set(h.shells, [
        shell(ref(a), { pendingRuntimeRequest: null }),
        shell(ref(b), { pendingRuntimeRequest: null }),
      ]);
      expect(h.registry.get(h.inbox.summaryAtom)).toEqual({ count: 0, total: 0, refs: [] });
      const reads = h.detailReads();
      expect(h.registry.get(h.inbox.itemsAtom)).toEqual({
        items: [],
        authoritativeRefs: [],
        feedEnvironments: [],
        loadingRefs: [],
        errors: [],
        isLoading: false,
      });
      expect(h.detailReads()).toBe(reads);
      h.flush();
      expect([...h.activeSources]).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it.each(nonconnectedPhases)(
    "excludes cached decisions for a %s presentation and restores enabled connections",
    (phase) => {
      const h = harness();
      const stop = h.registry.mount(h.inbox.itemsAtom);
      try {
        h.set(ref(a), []);
        h.set(ref(b), [request("cached", "2026-10-13T00:00:00Z")], "cached");
        const connected = h.registry.get(h.presentations(b))!;
        h.registry.set(
          h.presentations(b),
          phase === null
            ? null
            : {
                ...connected,
                connection: { phase, error: null, traceId: null },
              },
        );
        expect(h.registry.get(h.inbox.summaryAtom).refs).toEqual([ref(a)]);
        expect(h.registry.get(h.inbox.itemsAtom).items).toEqual([]);
        h.flush();
        expect([...h.activeSources]).toEqual([threadKey(ref(a))]);
        h.registry.set(h.presentations(b), connected);
        expect(
          h.registry.get(h.inbox.itemsAtom).items.map((entry) => requestOf(entry).requestId),
        ).toEqual(["cached"]);
        const catalog = h.registry.get(h.catalog);
        h.registry.set(h.catalog, {
          ...catalog,
          entries: new Map(
            [...catalog.entries].map(([id, entry]) => [
              id,
              id === b ? { ...entry, enabled: false } : entry,
            ]),
          ),
        });
        expect(h.registry.get(h.inbox.itemsAtom).items).toEqual([]);
        h.registry.set(h.presentations(b), connected);
        expect(h.registry.get(h.inbox.itemsAtom).items).toEqual([]);
      } finally {
        stop();
        h.registry.dispose();
      }
    },
  );

  it("retains cached and synchronizing decisions until live, with errors taking precedence over loading", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    try {
      h.set(ref(b), []);
      const pending = [request("retained", "2026-10-13T00:00:00Z")];
      for (const status of ["cached", "synchronizing"] as const) {
        h.set(ref(a), pending, status);
        const value = h.registry.get(h.inbox.itemsAtom);
        expect(value.items.map((entry) => requestOf(entry).requestId)).toEqual(["retained"]);
        expect(value.loadingRefs).toEqual([ref(a)]);
        expect(value.isLoading).toBe(true);
      }
      h.set(ref(a), pending, "cached", "Could not synchronize.");
      expect(h.registry.get(h.inbox.itemsAtom).loadingRefs).toEqual([]);
      expect(h.registry.get(h.inbox.itemsAtom).errors).toEqual([
        { ref: ref(a), message: "Could not synchronize." },
      ]);
      expect(h.registry.get(h.inbox.itemsAtom).items).toHaveLength(1);
      h.set(ref(a), pending);
      expect(h.registry.get(h.inbox.itemsAtom).loadingRefs).toEqual([]);
      expect(h.registry.get(h.inbox.itemsAtom).errors).toEqual([]);
      h.set(ref(a), pending, "deleted", "Deleted thread.");
      expect(h.registry.get(h.inbox.itemsAtom)).toEqual({
        items: [],
        authoritativeRefs: [ref(b)],
        feedEnvironments: [],
        loadingRefs: [],
        errors: [],
        isLoading: false,
      });
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("acquires details only for flagged connected refs and releases them when the screen closes", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    let stopItems = () => {};
    try {
      h.flush();
      expect(h.sourceReads.size).toBe(0);
      stopItems = h.registry.mount(h.inbox.itemsAtom);
      h.registry.get(h.inbox.itemsAtom);
      h.flush();
      expect([...h.activeSources].toSorted()).toEqual(
        [threadKey(ref(a)), threadKey(ref(b))].toSorted(),
      );
      const catalog = h.registry.get(h.catalog);
      h.registry.set(h.catalog, {
        ...catalog,
        entries: new Map(
          [...catalog.entries].map(([id, entry]) => [
            id,
            id === b ? { ...entry, enabled: false } : entry,
          ]),
        ),
      });
      h.registry.get(h.inbox.itemsAtom);
      h.flush();
      expect([...h.activeSources]).toEqual([threadKey(ref(a))]);
      h.registry.set(h.catalog, catalog);
      h.registry.get(h.inbox.itemsAtom);
      h.flush();
      const connected = h.registry.get(h.presentations(b))!;
      h.registry.set(h.presentations(b), {
        ...connected,
        connection: { phase: "offline", error: null, traceId: null },
      });
      h.registry.get(h.inbox.itemsAtom);
      h.flush();
      expect([...h.activeSources]).toEqual([threadKey(ref(a))]);
      h.registry.set(h.presentations(b), connected);
      h.registry.set(h.shells, [shell(ref(a), { pendingRuntimeRequest: null }), shell(ref(b))]);
      h.registry.get(h.inbox.itemsAtom);
      h.flush();
      expect([...h.activeSources]).toEqual([threadKey(ref(b))]);
      stopItems();
      h.flush();
      expect([...h.activeSources]).toEqual([]);
      expect(h.registry.get(h.inbox.summaryAtom).refs).toEqual([ref(b)]);
    } finally {
      stopItems();
      stopSummary();
      h.registry.dispose();
    }
  });

  it("advances only after a live resolution and prunes skips after replies and arrivals", () => {
    const h = harness();
    const stop = h.registry.mount(h.inbox.itemsAtom);
    try {
      const first = request("a", "2026-10-13T00:01:00Z");
      const second = request("b", "2026-10-13T00:02:00Z");
      h.set(ref(a), [first, second]);
      h.set(ref(b), []);
      let items = h.registry.get(h.inbox.itemsAtom).items;
      expect(items.map((entry) => requestOf(entry).requestId)).toEqual(["a", "b"]);
      // Transport success without a projection update leaves the same pending request visible.
      h.set(ref(a), [first, second]);
      expect(
        h.registry.get(h.inbox.itemsAtom).items.map((entry) => requestOf(entry).requestId),
      ).toEqual(["a", "b"]);
      let skips = skipDecisionItem(items, [], items[0]!.id);
      skips = skipDecisionItem(items, skips, items[1]!.id);
      h.set(ref(a), [
        { ...first, status: "resolved", resolvedAt: v2Now },
        second,
        request("c-old", "2026-10-13T00:00:00Z"),
        request("c-new", "2026-10-13T00:03:00Z"),
      ]);
      items = h.registry.get(h.inbox.itemsAtom).items;
      expect(items.map((entry) => requestOf(entry).requestId)).toEqual(["c-old", "b", "c-new"]);
      skips = skipDecisionItem(items, skips, "departed");
      expect(skips).toEqual([JSON.stringify(["a", "thread", "b"])]);
      expect(orderDecisionQueue(items, skips).map((entry) => requestOf(entry).requestId)).toEqual([
        "c-old",
        "c-new",
        "b",
      ]);
      skips = skipDecisionItem(items, skips, items[0]!.id);
      skips = skipDecisionItem(items, skips, items[1]!.id);
      expect(orderDecisionQueue(items, skips).map((entry) => requestOf(entry).requestId)).toEqual([
        "c-new",
        "c-old",
        "b",
      ]);
      h.set(ref(a), [
        { ...second, status: "resolved", resolvedAt: v2Now },
        request("last", "2026-10-13T00:04:00Z"),
      ]);
      items = h.registry.get(h.inbox.itemsAtom).items;
      skips = skipDecisionItem(items, skips, items[0]!.id);
      expect(orderDecisionQueue(items, skips).map((entry) => requestOf(entry).requestId)).toEqual([
        "last",
      ]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("uses the normal shell factory as the discovery source across environments", () => {
    const h = harness();
    const snapshots = Atom.family((_id: EnvironmentId) =>
      Atom.make({
        ...v2ShellSnapshot,
        threads: [
          {
            ...v2ThreadShell,
            id: ref().threadId,
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("flag"),
              kind: "command" as const,
              createdAt: v2Now,
            },
          },
        ],
      }),
    );
    const shells = createEnvironmentThreadShellAtoms({
      catalogValueAtom: h.catalog,
      snapshotAtom: snapshots,
    });
    const inbox = createDecisionInboxAtoms({
      catalogValueAtom: h.catalog,
      threadShellsAtom: shells.threadShellsAtom,
      presentationAtom: h.presentations,
      details: h.details,
    });
    const stopSummary = h.registry.mount(inbox.summaryAtom);
    let stopItems = () => {};
    try {
      expect(h.registry.get(inbox.summaryAtom).refs).toEqual([ref(a), ref(b)]);
      expect(h.sourceReads.size).toBe(0);
      h.set(ref(a), [request("one", "2026-10-13T00:00:00Z")]);
      h.set(ref(b), []);
      stopItems = h.registry.mount(inbox.itemsAtom);
      expect(
        h.registry.get(inbox.itemsAtom).items.map((entry) => requestOf(entry).requestId),
      ).toEqual(["one"]);
    } finally {
      stopItems();
      stopSummary();
      h.registry.dispose();
    }
  });
  it("lists a child's durable decision with its parent and holds, without counting, a question its parent is handling", () => {
    const h = harness();
    const stopSummary = h.registry.mount(h.inbox.summaryAtom);
    const stopItems = h.registry.mount(h.inbox.itemsAtom);
    try {
      const open = {
        options: [],
        recommended: null,
        requiredProfile: "worker",
        expiresAt: null,
        status: "open",
        answer: null,
        answeredBy: null,
        updatedAt: "2026-10-13T00:00:00.000Z",
        humanRequired: false,
      } as const;
      const decision: DurableDecision = {
        ...open,
        id: "decision:child",
        source: "decision",
        from: {
          environmentId: a,
          threadId: ThreadId.make("child"),
          threadTitle: "Child",
          parentThreadId: ThreadId.make("parent"),
          parentThreadTitle: "Parent",
        },
        title: "Pick a database",
        context: "Both pass the tests.",
        options: [{ id: "sqlite", label: "SQLite", consequence: "One file." }],
        createdAt: "2026-10-13T00:05:00.000Z",
        routedTo: "person",
      };
      const question: DurableDecision = {
        ...open,
        id: "pending:thread:question",
        source: "pending_request",
        from: {
          environmentId: a,
          threadId: ref(a).threadId,
          parentThreadId: ThreadId.make("parent"),
          parentThreadTitle: "Parent",
        },
        title: "Next",
        context: "What should happen next?",
        createdAt: "2026-10-13T00:02:00.000Z",
        routedTo: "parent",
        pending: {
          threadId: ref(a).threadId,
          requestId: RuntimeRequestId.make("question"),
          questions: [],
        },
      };
      h.registry.set(h.feeds(a), { items: [decision, question] });
      h.registry.set(h.feeds(b), { items: [] });
      h.set(
        ref(a),
        [
          {
            ...request("question", "2026-10-13T00:02:00Z"),
            kind: "user_input",
            responseCapability: { type: "message" },
          },
        ],
        "live",
        null,
        [questionItem],
      );
      h.set(ref(b), []);
      // Only the decision waits on the person; the question is listed while its parent works.
      expect(h.registry.get(h.inbox.summaryAtom)).toMatchObject({ count: 1, total: 2 });
      const value = h.registry.get(h.inbox.itemsAtom);
      expect(
        value.items.map((entry) => [entry.kind, entry.routing.routedTo, entry.routing.parentTitle]),
      ).toEqual([
        ["decision", "person", "Parent"],
        ["user_input", "parent", "Parent"],
      ]);
      const decisionId = value.items[0]!.id;
      expect(isDecisionItemRemoved(value, decisionId)).toBe(false);
      h.registry.set(h.feeds(a), { items: [question] });
      expect(isDecisionItemRemoved(h.registry.get(h.inbox.itemsAtom), decisionId)).toBe(true);
    } finally {
      stopItems();
      stopSummary();
      h.registry.dispose();
    }
  });
});
