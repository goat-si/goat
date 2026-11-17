import {
  EnvironmentId,
  MemoryChangeSignal,
  MemoryId,
  MemoryItem,
  MemoryHistoryPage,
  MemoryRevisionId,
  MemorySourcePage,
  MemorySpaceId,
  MessageId,
  type AuthSessionState,
  type ServerConfig,
  WS_METHODS,
} from "@goat/contracts";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createMemoryEnvironmentAtoms, memoryBodyGap } from "./memory.ts";

vi.mock("./connections.ts", () => ({
  createEnvironmentCatalogAtoms: () => ({
    catalogValueAtom: Atom.make({ entries: new Map([[env, { enabled: true }]]) }),
  }),
}));
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: grants,
    initialConfigValueAtom: configs,
    preparedConnectionValueAtom: prepared,
  }),
}));
const grants = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(null));
const prepared = Atom.family((_id: EnvironmentId) =>
  Atom.make(Option.some({} as PreparedConnection)),
);
const env = EnvironmentId.make("selected-tunnel");
const space = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const id = MemoryId.make("00000000-0000-4000-8000-000000000002");
const unrelated = MemoryId.make("00000000-0000-4000-8000-000000000003");
const target = { environmentId: env, input: { memorySpaceId: space } };
const readTarget = { environmentId: env, input: { memorySpaceId: space, memoryId: id } };
const decodeSignal = Schema.decodeUnknownSync(MemoryChangeSignal);
const signal = (kind: MemoryChangeSignal["kind"], memoryId = id) =>
  decodeSignal({
    memorySpaceId: space,
    projectionWatermark: 1,
    kind,
    ...(kind === "reset" ? {} : { memoryId }),
  });
const revision = {
  memorySpaceId: space,
  memoryId: id,
  revisionId: "00000000-0000-4000-8000-000000000004",
  operationId: "00000000-0000-4000-8000-000000000005",
  parents: [],
  scope: { kind: "user" },
  payloadRef: "00000000-0000-4000-8000-000000000004",
  assertionKind: "fact",
  provenance: { environmentId: env },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
};
const payload = {
  text: "Synthetic memory",
  evidence: [{ origin: "user", messageIds: [] }],
  derivedFromMemoryRevisions: [],
};
const visible = { exposure: "visible", reasons: [], deferred: [], cleanupPending: false };
const item = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: space,
  memoryId: id,
  status: "active",
  pendingSync: false,
  localAvailability: visible,
  scope: { kind: "user" },
  revision,
  payload,
});
const history = Schema.decodeUnknownSync(MemoryHistoryPage)({
  memoryId: id,
  revisions: [{ revision, payload }],
  resolutions: [],
  tombstone: null,
  reports: [],
  revertResults: [],
  localAvailability: visible,
  nextCursor: null,
});
const resolutionId = "00000000-0000-4000-8000-000000000021";
/** History whose resolution carries a judgment, as the details view renders it. */
const judged = Schema.decodeUnknownSync(MemoryHistoryPage)({
  memoryId: id,
  revisions: [{ revision, payload }],
  resolutions: [
    {
      resolution: {
        resolutionId,
        memorySpaceId: space,
        memoryId: id,
        inputRevisionIds: [
          "00000000-0000-4000-8000-000000000022",
          "00000000-0000-4000-8000-000000000023",
        ],
        inputPayloadRefs: [
          "00000000-0000-4000-8000-000000000022",
          "00000000-0000-4000-8000-000000000023",
        ],
        judgmentRef: resolutionId,
        requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
        effectiveProvider: "codex",
        effectiveModel: "synthetic",
        resolvingEnvironmentId: env,
        fencingToken: 1,
        resultRevisionId: revision.revisionId,
        appliedAtUtc: "2026-10-14T00:00:00.000Z",
        revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
      },
      payload: { resolutionId, judgment: "Synthetic judgment" },
    },
  ],
  tombstone: null,
  reports: [],
  revertResults: [],
  localAvailability: visible,
  nextCursor: null,
});
const sourcePage = Schema.decodeSync(MemorySourcePage)({
  sourceThread: { environmentId: env, threadId: "synthetic-thread" },
  watermark: { fromEventId: "e1", toEventId: "e2", throughSequence: 2 },
  messages: [{ messageId: "m1", text: "Synthetic source" }],
  nextCursor: null,
});
function waitFor<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  predicate: (value: A) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runHead,
  );
}

/** One environment whose memory subscription and reads the test drives by hand. */
const harness = Effect.fn(function* ({ holdPages = false }: { readonly holdPages?: boolean } = {}) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const signals = yield* Queue.unbounded<MemoryChangeSignal>();
  const reads = yield* Queue.unbounded<Deferred.Deferred<MemoryItem>>();
  // With holdPages, history and source requests wait for the test to answer them.
  const historyReplies = yield* Queue.unbounded<Deferred.Deferred<MemoryHistoryPage>>();
  const sourceReplies = yield* Queue.unbounded<Deferred.Deferred<MemorySourcePage>>();
  const held = <A>(replies: Queue.Queue<Deferred.Deferred<A>>) =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<A>();
      yield* Queue.offer(replies, reply);
      return yield* Deferred.await(reply);
    });
  let historyRequests = 0;
  const client = {
    [WS_METHODS.memoryChanges]: () => Stream.fromQueue(signals),
    [WS_METHODS.memoryRead]: () =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<MemoryItem>();
        yield* Queue.offer(reads, reply);
        return yield* Deferred.await(reply);
      }),
    [WS_METHODS.memoryHistory]: () =>
      Effect.suspend(() => {
        historyRequests++;
        return holdPages ? held(historyReplies) : Effect.succeed(history);
      }),
    [WS_METHODS.memoryReadSource]: () =>
      holdPages ? held(sourceReplies) : Effect.succeed(sourcePage),
  };
  const active = yield* SubscriptionRef.make(
    Option.some({ client, initialConfig: Effect.succeed(config) } as unknown as RpcSession),
  );
  const supervisor = {
    target: { environmentId: env },
    session: active,
  } as unknown as EnvironmentSupervisor["Service"];
  const environments = {
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as Pick<
    EnvironmentRegistry["Service"],
    "run" | "followStream"
  > as EnvironmentRegistry["Service"];
  const clock = yield* Clock.Clock;
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(Clock.Clock, clock),
    ),
  );
  const memory = createMemoryEnvironmentAtoms(runtime);
  registry.mount(grants(env));
  registry.mount(configs(env));
  registry.mount(prepared(env));
  registry.set(
    grants(env),
    AsyncResult.success({
      authenticated: true,
      // Reading the original conversation also needs orchestration:read.
      scopes: ["memory:read", "memory:write", "orchestration:read"],
      permissions: ["memory:read", "memory:write", "orchestration:read"],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "synthetic",
      },
    }),
  );
  registry.set(configs(env), config);
  const exposure = memory.exposureAtom(target);
  registry.mount(exposure);
  yield* Queue.offer(signals, signal("reset"));
  yield* waitFor(registry, exposure, (state) => state.ready);
  const edit = memory.draftAtom({ ...target, draftId: "edit" });
  registry.mount(edit);
  return {
    registry,
    memory,
    exposure,
    edit,
    signals,
    reads,
    historyReplies,
    sourceReplies,
    active,
    historyRequests: () => historyRequests,
  };
});
const config = {
  environment: { capabilities: { memory: { protocolVersion: 1 } } },
} as ServerConfig;

it.effect("an expired body leaves the open draft and reports the memory unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      const source = h.memory.read(readTarget);
      const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
      h.registry.mount(body);
      yield* Deferred.succeed(yield* Queue.take(h.reads), item);
      yield* waitFor(h.registry, body, Option.isSome);
      const seen = h.registry.get(h.exposure);
      h.registry.set(h.edit, { text: "Synthetic memory, edited", memoryIds: [id] });
      yield* TestClock.adjust("1 minute");
      yield* waitFor(h.registry, body, Option.isNone);
      expect(h.registry.get(h.edit)).toBe("Synthetic memory, edited");
      expect(memoryBodyGap(seen, h.registry.get(h.exposure), id)).toBe("unchanged");
    }),
  ),
);

it.effect.each([
  { change: "forget this", expected: "forgotten" },
  { change: "forget another", expected: "forgotten" },
  { change: "upsert this", expected: "changed" },
  { change: "invalidate this", expected: "changed" },
  { change: "reset", expected: "unavailable" },
  { change: "disconnect", expected: "unavailable" },
] as const)(
  "$change reports the open memory $expected and purges its draft",
  ({ change, expected }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const seen = h.registry.get(h.exposure);
        h.registry.set(h.edit, { text: "Synthetic memory, edited", memoryIds: [id] });
        if (change === "disconnect") yield* SubscriptionRef.set(h.active, Option.none());
        else
          yield* Queue.offer(
            h.signals,
            change === "forget this"
              ? signal("forget")
              : change === "forget another"
                ? signal("forget", unrelated)
                : change === "upsert this"
                  ? signal("upsert")
                  : change === "invalidate this"
                    ? signal("invalidate")
                    : signal("reset"),
          );
        yield* waitFor(h.registry, h.exposure, (state) => state !== seen);
        expect(memoryBodyGap(seen, h.registry.get(h.exposure), id)).toBe(expected);
        expect(h.registry.get(h.edit)).toBeNull();
      }),
    ),
);

it.effect("a version change of the open memory requests its read and history again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      const source = h.memory.read(readTarget);
      const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
      const pages = h.memory.history({ ...readTarget, input: { ...readTarget.input, limit: 10 } });
      const page = Atom.make((get) => Option.flatten(AsyncResult.value(get(pages))));
      h.registry.mount(body);
      h.registry.mount(page);
      yield* Deferred.succeed(yield* Queue.take(h.reads), item);
      yield* waitFor(h.registry, body, Option.isSome);
      yield* waitFor(h.registry, page, Option.isSome);
      expect(h.historyRequests()).toBe(1);
      yield* Queue.offer(h.signals, signal("upsert"));
      yield* Deferred.succeed(yield* Queue.take(h.reads), item);
      yield* waitFor(h.registry, body, Option.isSome);
      yield* waitFor(h.registry, page, Option.isSome);
      expect(h.historyRequests()).toBe(2);
    }),
  ),
);
it.effect.each(["upsert", "invalidate"] as const)(
  "a second change to an open memory (%s) hides its body, purges a new draft and reports it changed",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const source = h.memory.read(readTarget);
        const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
        h.registry.mount(body);
        yield* Deferred.succeed(yield* Queue.take(h.reads), item);
        yield* waitFor(h.registry, body, Option.isSome);
        yield* Queue.offer(h.signals, signal("upsert"));
        yield* Deferred.succeed(yield* Queue.take(h.reads), item);
        yield* waitFor(h.registry, body, Option.isSome);
        const seen = h.registry.get(h.exposure);
        h.registry.set(h.edit, { text: "Synthetic memory, edited", memoryIds: [id] });
        yield* Queue.offer(h.signals, signal(kind));
        yield* waitFor(h.registry, h.exposure, (state) => state !== seen);
        expect(memoryBodyGap(seen, h.registry.get(h.exposure), id)).toBe("changed");
        expect(Option.isNone(h.registry.get(body))).toBe(true);
        expect(h.registry.get(h.edit)).toBeNull();
      }),
    ),
);
const revisionId = (n: number) =>
  MemoryRevisionId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const since = "2026-10-14T00:00:00.000Z";
const decodeItem = Schema.decodeUnknownSync(MemoryItem);
const blocked = (
  reason: "scanner_pending" | "secret_detected" | "forget_pending",
  revision = revisionId(4),
) =>
  decodeItem({
    memorySpaceId: space,
    memoryId: id,
    status: "blocked",
    scope: { kind: "user" },
    failureCode: reason,
    pendingSync: false,
    localAvailability: {
      exposure: "held",
      reasons: [reason],
      deferred:
        reason === "forget_pending"
          ? []
          : [
              reason === "scanner_pending"
                ? {
                    kind: "scanner",
                    state: "pending",
                    reason,
                    revisionId: revision,
                    generation: 1,
                    sinceAtUtc: since,
                  }
                : {
                    kind: "scanner",
                    state: "held",
                    reason,
                    revisionId: revision,
                    generation: 1,
                    sinceAtUtc: since,
                  },
              {
                kind: "index",
                state: "pending",
                reason: "index_unavailable",
                revisionId: revision,
                generation: 1,
                sinceAtUtc: since,
              },
            ],
      cleanupPending: false,
    },
  });
const otherRevision = decodeItem({
  ...item,
  revision: {
    ...revision,
    revisionId: revisionId(6),
    operationId: revisionId(7),
    payloadRef: revisionId(6),
  },
  payload: { ...payload, text: "Synthetic memory, saved elsewhere" },
});
const isStatus = (status: MemoryItem["status"]) => (value: Option.Option<MemoryItem>) =>
  Option.isSome(value) && value.value.status === status;

/** An edit opened on the visible revision 4, typed into or not, with its body read mounted. */
const openEdit = Effect.fn(function* (typed: boolean) {
  const h = yield* harness();
  const source = h.memory.read(readTarget);
  const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
  h.registry.mount(body);
  yield* Deferred.succeed(yield* Queue.take(h.reads), item);
  yield* waitFor(h.registry, body, Option.isSome);
  h.registry.set(h.edit, {
    text: "Synthetic memory",
    memoryIds: [id],
    expectedHeads: [revisionId(4)],
  });
  if (typed) h.registry.set(h.edit, { text: "Synthetic memory, edited", memoryIds: [id] });
  const text = typed ? "Synthetic memory, edited" : "Synthetic memory";
  /** A change signal, then the reread it causes, answered with reply. */
  const change = Effect.fn(function* (kind: "upsert" | "invalidate", reply: MemoryItem) {
    yield* Queue.offer(h.signals, signal(kind));
    const reread = yield* Queue.take(h.reads);
    // The decision waits for the reread: the draft is unchanged while it is pending.
    expect(h.registry.get(h.edit)).toBe(text);
    yield* Deferred.succeed(reread, reply);
    yield* waitFor(h.registry, body, isStatus(reply.status));
  });
  return { ...h, body, text, change };
});

it.effect(
  "an edited draft survives its own save's hub confirmation and the scanner's release",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* openEdit(true);
        // The hub's confirmation re-projects this device's own revision as held for a re-scan.
        yield* h.change("upsert", blocked("scanner_pending"));
        expect(h.registry.get(h.edit)).toBe(h.text);
        // The scanner releases the same revision.
        yield* h.change("invalidate", item);
        expect(h.registry.get(h.edit)).toBe(h.text);
      }),
    ),
);

it.effect.each([true, false])(
  "a change signal whose reread shows the same visible revision keeps the draft (typed: %s)",
  (typed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* openEdit(typed);
        yield* h.change("upsert", item);
        expect(h.registry.get(h.edit)).toBe(h.text);
      }),
    ),
);

it.effect(
  "an untouched draft is purged under the scanner hold, as the read-only body is hidden",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* openEdit(false);
        yield* h.change("upsert", blocked("scanner_pending"));
        yield* waitFor(h.registry, h.edit, (text) => text === null);
        expect(h.registry.get(h.edit)).toBeNull();
      }),
    ),
);

it.effect.each([
  { reread: "a different revision", reply: otherRevision },
  { reread: "a detected secret", reply: blocked("secret_detected") },
  { reread: "a pending forget hold", reply: blocked("forget_pending") },
  { reread: "a re-scan of another revision", reply: blocked("scanner_pending", revisionId(6)) },
])("a reread showing $reread purges an edited draft", ({ reply }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* openEdit(true);
      yield* h.change("upsert", reply);
      yield* waitFor(h.registry, h.edit, (text) => text === null);
      expect(h.registry.get(h.edit)).toBeNull();
    }),
  ),
);

it.effect("a re-scan that ends in a detected secret purges an edited draft", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* openEdit(true);
      yield* h.change("upsert", blocked("scanner_pending"));
      expect(h.registry.get(h.edit)).toBe(h.text);
      yield* h.change("invalidate", blocked("secret_detected"));
      yield* waitFor(h.registry, h.edit, (text) => text === null);
      expect(h.registry.get(h.edit)).toBeNull();
    }),
  ),
);

it.effect("a reread that never answers purges an edited draft when it times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* openEdit(true);
      yield* Queue.offer(h.signals, signal("upsert"));
      yield* Queue.take(h.reads);
      expect(h.registry.get(h.edit)).toBe(h.text);
      yield* TestClock.adjust("1 minute");
      yield* waitFor(h.registry, h.edit, (text) => text === null);
      expect(h.registry.get(h.edit)).toBeNull();
    }),
  ),
);

it.effect("a draft written without a starting revision still purges on any change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      const seen = h.registry.get(h.exposure);
      h.registry.set(h.edit, { text: "Synthetic memory", memoryIds: [id] });
      h.registry.set(h.edit, { text: "Synthetic memory, edited", memoryIds: [id] });
      yield* Queue.offer(h.signals, signal("upsert"));
      yield* waitFor(h.registry, h.exposure, (state) => state !== seen);
      expect(h.registry.get(h.edit)).toBeNull();
    }),
  ),
);
it.effect(
  "an edited draft survives a re-scan that runs past the read's minute, then its release",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* openEdit(true);
        yield* h.change("upsert", blocked("scanner_pending"));
        // The held reply expires after its minute while the scanner is still queued.
        yield* TestClock.adjust("61 seconds");
        yield* waitFor(h.registry, h.body, Option.isNone);
        expect(h.registry.get(h.edit)).toBe(h.text);
        yield* h.change("invalidate", item);
        expect(h.registry.get(h.edit)).toBe(h.text);
      }),
    ),
);
it.effect(
  "chosen behaviour: after a later change, an edited draft whose reread gets no answer within 60 seconds is discarded",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* openEdit(true);
        // An earlier change the draft survived, so the next signal is a later one.
        yield* h.change("upsert", item);
        expect(h.registry.get(h.edit)).toBe(h.text);
        yield* Queue.offer(h.signals, signal("upsert"));
        yield* Queue.take(h.reads);
        expect(h.registry.get(h.edit)).toBe(h.text);
        yield* TestClock.adjust("60 seconds");
        yield* waitFor(h.registry, h.edit, (text) => text === null);
        expect(h.registry.get(h.edit)).toBeNull();
      }),
    ),
);
/** Collects garbage inside this test only: the flag is switched off again before any other code runs. */
const collectGarbage = Effect.sync(() => {
  NodeV8.setFlagsFromString("--expose-gc");
  let gc: () => void;
  try {
    gc = NodeVM.runInNewContext("gc") as () => void;
  } finally {
    NodeV8.setFlagsFromString("--no-expose-gc");
  }
  gc();
});

/** Answers every read request with reply and counts them. */
const answerReads = Effect.fn(function* (
  reads: Queue.Queue<Deferred.Deferred<MemoryItem>>,
  reply: MemoryItem,
) {
  let count = 0;
  yield* Queue.take(reads).pipe(
    Effect.flatMap((request) => {
      count++;
      return Deferred.succeed(request, reply);
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  return () => count;
});

it.effect("the visible read and the draft's decision share one request, across a collection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* openEdit(true);
      yield* collectGarbage;
      const requests = yield* answerReads(h.reads, otherRevision);
      yield* Queue.offer(h.signals, signal("upsert"));
      yield* waitFor(h.registry, h.edit, (text) => text === null);
      yield* waitFor(
        h.registry,
        h.body,
        (value) => Option.isSome(value) && value.value === otherRevision,
      );
      // One memory.read answers both the details on screen and the draft's decision.
      expect(requests()).toBe(1);
    }),
  ),
);

it.effect("a read opened after a collection is the one the draft's decision is waiting on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      h.registry.set(h.edit, {
        text: "Synthetic memory",
        memoryIds: [id],
        expectedHeads: [revisionId(4)],
      });
      h.registry.set(h.edit, { text: "Synthetic memory, edited", memoryIds: [id] });
      const seen = h.registry.get(h.exposure);
      yield* Queue.offer(h.signals, signal("upsert"));
      yield* waitFor(h.registry, h.exposure, (state) => state !== seen);
      // Only the draft holds the read now, through its decision.
      expect(h.registry.get(h.edit)).toBe("Synthetic memory, edited");
      yield* collectGarbage;
      const requests = yield* answerReads(h.reads, item);
      const body = Atom.make((get) =>
        Option.flatten(AsyncResult.value(get(h.memory.read(readTarget)))),
      );
      h.registry.mount(body);
      yield* waitFor(h.registry, body, Option.isSome);
      yield* waitFor(h.registry, h.edit, (text) => text === "Synthetic memory, edited");
      expect(requests()).toBe(1);
    }),
  ),
);

it.effect(
  "every hold withholds the open memory's history, judgment and original conversation, the second as the first",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ holdPages: true });
        const shown = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<Option.Option<A>, E>>) =>
          Atom.make((get) => Option.flatten(AsyncResult.value(get(atom))));
        const body = shown(h.memory.read(readTarget));
        const past = shown(
          h.memory.history({ ...readTarget, input: { ...readTarget.input, limit: 10 } }),
        );
        const original = shown(
          h.memory.readSource({
            ...readTarget,
            input: {
              ...readTarget.input,
              sourceThread: sourcePage.sourceThread,
              messageIds: [MessageId.make("m1")],
              limit: 10,
            },
          }),
        );
        h.registry.mount(body);
        h.registry.mount(past);
        h.registry.mount(original);
        const answerPages = Effect.gen(function* () {
          yield* Deferred.succeed(yield* Queue.take(h.historyReplies), judged);
          yield* Deferred.succeed(yield* Queue.take(h.sourceReplies), sourcePage);
          yield* waitFor(h.registry, past, Option.isSome);
          yield* waitFor(h.registry, original, Option.isSome);
        });
        yield* Deferred.succeed(yield* Queue.take(h.reads), item);
        yield* waitFor(h.registry, body, Option.isSome);
        yield* answerPages;
        expect(JSON.stringify(h.registry.get(past))).toContain("Synthetic judgment");
        expect(JSON.stringify(h.registry.get(original))).toContain("Synthetic source");
        h.registry.set(h.edit, {
          text: "Synthetic memory",
          memoryIds: [id],
          expectedHeads: [revisionId(4)],
        });
        h.registry.set(h.edit, { text: "Synthetic memory, edited", memoryIds: [id] });
        /** A hold signal; its reread answers with reply. */
        const hold = Effect.fn(function* (reply: MemoryItem) {
          const seen = h.registry.get(h.exposure);
          yield* Queue.offer(h.signals, signal("invalidate"));
          yield* waitFor(h.registry, h.exposure, (state) => state !== seen);
          // Withheld at the signal, before any reread answers.
          expect(Option.isNone(h.registry.get(past))).toBe(true);
          expect(Option.isNone(h.registry.get(original))).toBe(true);
          expect(Option.isNone(h.registry.get(body))).toBe(true);
          yield* Deferred.succeed(yield* Queue.take(h.reads), reply);
          yield* waitFor(h.registry, body, isStatus(reply.status));
        });
        // First hold: this device re-scans revision 4, so the edited draft stays open.
        yield* hold(blocked("scanner_pending"));
        expect(h.registry.get(h.edit)).toBe("Synthetic memory, edited");
        yield* answerPages;
        // Second hold: a secret detected by another device's scan.
        yield* hold(blocked("secret_detected"));
        yield* waitFor(h.registry, h.edit, (text) => text === null);
        expect(h.registry.get(h.edit)).toBeNull();
      }),
    ),
);
