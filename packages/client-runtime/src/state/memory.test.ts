import { createMemoryImportRecoveryStore } from "../memoryImportRecovery.ts";
import {
  EnvironmentId,
  MemorySpaceId,
  MemoryOperationId,
  MemoryId,
  MemoryItem,
  MemoryPage,
  MemoryHistoryPage,
  MemorySourcePage,
  MemoryRpcError,
  ThreadId,
  MessageId,
  MemoryChangeSignal,
  MemoryImportProviderResult,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ServerConfig,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HashMap from "effect/HashMap";
import type { EnvironmentCatalogState } from "./connections.ts";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry, EnvironmentNotRegisteredError } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { requestMemoryQuery } from "../rpc/client.ts";
import {
  createMemoryEnvironmentAtoms,
  createMemoryTombstoneLedger,
  applyMemoryChange,
  emptyMemoryExposure,
  memoryExposureMatches,
} from "./memory.ts";

vi.mock("./connections.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connections.ts")>();
  return {
    ...actual,
    createEnvironmentCatalogAtoms: (
      ...args: Parameters<typeof actual.createEnvironmentCatalogAtoms>
    ) => {
      const override = catalogOverrides.get(args[0]);
      return override
        ? { catalogValueAtom: override }
        : actual.createEnvironmentCatalogAtoms(...args);
    },
  };
});
const catalogOverrides = new WeakMap<object, Atom.Atom<EnvironmentCatalogState>>();

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
const other = EnvironmentId.make("other-remote");
const space = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const id = MemoryId.make("00000000-0000-4000-8000-000000000002");
const unrelated = MemoryId.make("00000000-0000-4000-8000-000000000003");
const target = { environmentId: env, input: { memorySpaceId: space } };
const readTarget = { environmentId: env, input: { memorySpaceId: space, memoryId: id } };
const config = {
  environment: {
    capabilities: { memory: { protocolVersion: 1, importProvider: true, hubDiagnostics: true } },
  },
} as ServerConfig;
function sessionScopes(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes,
    permissions: scopes,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "synthetic",
    },
  };
}
const decodeMemoryPage = Schema.decodeUnknownEffect(MemoryPage);
const decodeMemoryItem = Schema.decodeUnknownEffect(MemoryItem);
const decodeMemoryHistory = Schema.decodeUnknownEffect(MemoryHistoryPage);
const decodeSignal = Schema.decodeUnknownSync(MemoryChangeSignal);
const decodeImport = Schema.decodeUnknownSync(MemoryImportProviderResult);
const signal = (kind: MemoryChangeSignal["kind"], memoryId = id) =>
  decodeSignal({
    memorySpaceId: space,
    projectionWatermark: 1,
    kind,
    ...(kind === "reset" ? {} : { memoryId }),
  });
const item = Schema.decodeUnknownSync(MemoryItem)({
  memorySpaceId: space,
  memoryId: id,
  status: "active",
  pendingSync: false,
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
  scope: { kind: "user" },
  revision: {
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
  },
  payload: {
    text: "Synthetic memory",
    evidence: [{ origin: "user", messageIds: [] }],
    derivedFromMemoryRevisions: [],
  },
});
const unrelatedItem = Schema.decodeUnknownSync(MemoryItem)({
  ...item,
  memoryId: unrelated,
  ...(item.status === "active"
    ? {
        revision: {
          ...item.revision,
          memoryId: unrelated,
          revisionId: "00000000-0000-4000-8000-000000000008",
          payloadRef: "00000000-0000-4000-8000-000000000008",
        },
      }
    : {}),
});
const page = Schema.decodeUnknownSync(MemoryPage)({
  items: [item],
  projectionWatermark: 1,
  nextCursor: null,
});
const history = Schema.decodeUnknownSync(MemoryHistoryPage)({
  memoryId: id,
  revisions: item.status === "active" ? [{ revision: item.revision, payload: item.payload }] : [],
  resolutions: [],
  tombstone: null,
  reports: [],
  revertResults: [],
  localAvailability: { exposure: "visible", reasons: [], deferred: [], cleanupPending: false },
  nextCursor: null,
});
const sourcePage = Schema.decodeUnknownSync(MemorySourcePage)({
  sourceThread: { environmentId: env, threadId: "synthetic-thread" },
  watermark: { fromEventId: "e1", toEventId: "e2", throughSequence: 2 },
  messages: [{ messageId: "m1", text: "Synthetic source" }],
  nextCursor: null,
});
function hasBody<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<Option.Option<A>, E>>) {
  return Atom.make((get) => {
    const result = get(atom);
    return result._tag === "Success" && Option.isSome(result.value);
  });
}
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
const harness = Effect.fn(function* (
  ledger = createMemoryTombstoneLedger(),
  pageValue = page,
  repeatPages = false,
  historyValue = history,
) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const queue = yield* Queue.unbounded<
    MemoryChangeSignal | MemoryRpcError | RpcClientError.RpcClientError
  >();
  const otherQueue = yield* Queue.unbounded<MemoryChangeSignal>();
  const readStarted = yield* Deferred.make<void>();
  const reply = yield* Deferred.make<MemoryItem, MemoryRpcError>();
  const readFinalized = yield* Deferred.make<void>();
  const reads = yield* Queue.unbounded<{
    reply: Deferred.Deferred<MemoryItem, MemoryRpcError>;
    finalized: Deferred.Deferred<void>;
  }>();
  let subscriptions = 0;
  const destinations: EnvironmentId[] = [];
  let readCount = 0;
  const responded = new Set<string>();
  const respondOnce = <A>(method: string, value: A) =>
    Effect.suspend(() => {
      if (responded.has(method) && !repeatPages) return Effect.never;
      responded.add(method);
      return Deferred.await(reply).pipe(Effect.as(value));
    });
  const historyInputs: unknown[] = [];
  let diagnosticRequests = 0;
  const rpc = {
    [WS_METHODS.memoryHubDiagnostics]: () =>
      Effect.sync(() => {
        diagnosticRequests++;
        return {};
      }),
    [WS_METHODS.memoryHubReconcile]: () =>
      Effect.sync(() => {
        diagnosticRequests++;
        return { version: 1, rearmedClasses: [] };
      }),
    [WS_METHODS.memoryChanges]: () => {
      subscriptions++;
      return Stream.fromQueue(queue).pipe(
        Stream.mapEffect((event) => ("kind" in event ? Effect.succeed(event) : Effect.fail(event))),
      );
    },
    [WS_METHODS.memoryRead]: () =>
      Effect.gen(function* () {
        const first = ++readCount === 1;
        const response = first ? reply : yield* Deferred.make<MemoryItem, MemoryRpcError>();
        const finalized = first ? readFinalized : yield* Deferred.make<void>();
        yield* Queue.offer(reads, { reply: response, finalized });
        if (first) yield* Deferred.succeed(readStarted, undefined);
        return yield* Deferred.await(response).pipe(
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        );
      }),
    [WS_METHODS.memoryList]: () => respondOnce("list", pageValue),
    [WS_METHODS.memorySearch]: () => respondOnce("search", pageValue),
    [WS_METHODS.memoryHistory]: (input: unknown) => {
      historyInputs.push(input);
      return respondOnce("history", historyValue);
    },
    [WS_METHODS.memoryReadSource]: () => respondOnce("source", sourcePage),
    [WS_METHODS.memoryImportProvider]: () =>
      Effect.succeed(decodeImport({ action: "discover", sources: [] })),
  };
  const active = yield* SubscriptionRef.make(
    Option.some({
      client: rpc,
      initialConfig: Effect.sync(() => registry.get(configs(env)) ?? config),
    } as unknown as RpcSession),
  );
  const supervisor = {
    target: { environmentId: env, label: "Selected tunnel" },
    session: active,
  } as unknown as EnvironmentSupervisor["Service"];
  const otherActive = yield* SubscriptionRef.make(
    Option.some({
      client: { [WS_METHODS.memoryChanges]: () => Stream.fromQueue(otherQueue) },
      initialConfig: Effect.succeed(config),
    } as unknown as RpcSession),
  );
  const otherSupervisor = {
    target: { environmentId: other },
    session: otherActive,
  } as unknown as EnvironmentSupervisor["Service"];
  let available = true;
  const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) => {
    destinations.push(environmentId);
    return available && environmentId === env
      ? Effect.provideService(effect, EnvironmentSupervisor, supervisor)
      : Effect.fail(new EnvironmentNotRegisteredError({ environmentId }));
  };
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (environmentId, stream) =>
    environmentId === env
      ? Stream.provideService(stream, EnvironmentSupervisor, supervisor)
      : environmentId === other
        ? Stream.provideService(stream, EnvironmentSupervisor, otherSupervisor)
        : Stream.empty;
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([
      [env, { enabled: true } as ConnectionCatalogEntry],
      [other, { enabled: true } as ConnectionCatalogEntry],
    ]),
  );
  const clock = yield* Clock.Clock;
  const environments = { run, followStream, entries } as unknown as EnvironmentRegistry["Service"];
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(Clock.Clock, clock),
    ),
  );
  const memory = createMemoryEnvironmentAtoms(runtime, ledger);
  registry.mount(grants(env));
  registry.mount(grants(other));
  registry.mount(configs(env));
  registry.mount(configs(other));
  registry.mount(prepared(env));
  registry.mount(prepared(other));
  registry.set(
    grants(env),
    AsyncResult.success(
      sessionScopes(["memory:read", "memory:write", "filesystem:read", "orchestration:read"]),
    ),
  );
  registry.set(grants(other), AsyncResult.success(sessionScopes([])));
  registry.set(configs(env), config);
  registry.set(configs(other), config);
  yield* waitFor(
    registry,
    memory.importProvider.permissionAtom(env, {
      memorySpaceId: space,
      action: "discover",
      format: "claude",
    }),
    Boolean,
  );
  return {
    diagnosticRequests: () => diagnosticRequests,
    registry,
    entries,
    memory,
    active,
    queue,
    otherQueue,
    rpc,
    runtime,
    environments,
    ledger,
    recreate: () => createMemoryEnvironmentAtoms(runtime, ledger),
    historyInputs,
    readCount: () => readCount,
    reads,
    readFinalized,
    readStarted,
    reply,
    destinations,
    subscriptions: () => subscriptions,
    remove: () => {
      available = false;
      return SubscriptionRef.set(entries, new Map());
    },
  };
});

describe("shared memory client", () => {
  it("fences reset/hold/dependency/forget and never resurrects an observed tombstone", () => {
    const initial = applyMemoryChange(emptyMemoryExposure(), signal("reset"));
    for (const kind of ["reset", "invalidate", "forget"] as const) {
      const changed = applyMemoryChange(initial, signal(kind));
      expect(memoryExposureMatches(initial, changed, [id])).toBe(false);
      if (kind !== "reset") expect(memoryExposureMatches(initial, changed, [unrelated])).toBe(true);
    }
    const forgotten = applyMemoryChange(initial, signal("forget"));
    const reset = applyMemoryChange(forgotten, signal("reset"));
    const newer = applyMemoryChange(reset, signal("upsert"));
    expect(memoryExposureMatches(newer, newer, [id])).toBe(false);
  });

  it.effect(
    "uses the selected destination and compound import grants, and rejects a removed environment",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const request = {
            environmentId: env,
            input: { memorySpaceId: space, action: "discover" as const, format: "claude" as const },
          };
          expect(h.registry.get(h.memory.importProvider.permissionAtom(env, request.input))).toBe(
            true,
          );
          expect(
            (yield* Effect.promise(() => h.memory.importProvider.run(h.registry, request)))._tag,
          ).toBe("Success");
          expect(h.destinations).toEqual([env]);
          for (const scopes of [["memory:write"], ["filesystem:read"], []] as const) {
            h.registry.set(grants(env), AsyncResult.success(sessionScopes(scopes)));
            expect(h.registry.get(h.memory.importProvider.permissionAtom(env, request.input))).toBe(
              false,
            );
            expect(
              (yield* Effect.promise(() => h.memory.importProvider.run(h.registry, request)))._tag,
            ).toBe("Failure");
          }
          h.registry.set(
            grants(env),
            AsyncResult.success(sessionScopes(["memory:write", "filesystem:read"])),
          );
          h.registry.set(configs(env), {
            environment: { capabilities: { memory: { protocolVersion: 1 } } },
          } as ServerConfig);
          expect(h.registry.get(h.memory.importProvider.permissionAtom(env, request.input))).toBe(
            false,
          );
          yield* h.remove();
          expect(
            (yield* Effect.promise(() => h.memory.importProvider.run(h.registry, request)))._tag,
          ).toBe("Failure");
          expect(h.destinations.every((destination) => destination === env)).toBe(true);
          expect(h.registry.get(h.memory.importProvider.permissionAtom(other, request.input))).toBe(
            false,
          );
        }),
      ),
  );

  it.effect("never dispatches hub diagnostics or reconcile without the advertised capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(
          grants(env),
          AsyncResult.success(sessionScopes(["memory:read", "settings:write"])),
        );
        const reconcile = { memorySpaceId: space, environmentId: env, expectedVersion: 1 };
        for (const memory of [
          { protocolVersion: 1 },
          { protocolVersion: 1, hubDiagnostics: false },
        ]) {
          h.registry.set(configs(env), {
            environment: { capabilities: { memory } },
          } as ServerConfig);
          expect(h.registry.get(h.memory.hubDiagnostics.permissionAtom(env))).toBe(false);
          expect(h.registry.get(h.memory.hubReconcile.permissionAtom(env))).toBe(false);
          expect(
            (yield* Effect.promise(() =>
              h.memory.hubDiagnostics.run(h.registry, { environmentId: env, input: {} }),
            ))._tag,
          ).toBe("Failure");
          expect(
            (yield* Effect.promise(() =>
              h.memory.hubReconcile.run(h.registry, { environmentId: env, input: reconcile }),
            ))._tag,
          ).toBe("Failure");
        }
        expect(h.diagnosticRequests()).toBe(0);
        h.registry.set(configs(env), config);
        expect(
          (yield* Effect.promise(() =>
            h.memory.hubDiagnostics.run(h.registry, { environmentId: env, input: {} }),
          ))._tag,
        ).toBe("Success");
        expect(
          (yield* Effect.promise(() =>
            h.memory.hubReconcile.run(h.registry, { environmentId: env, input: reconcile }),
          ))._tag,
        ).toBe("Success");
        expect(h.diagnosticRequests()).toBe(2);
      }),
    ),
  );

  it.effect("hub reconcile follows live Settings permission on the exact destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const input = { memorySpaceId: space, environmentId: env, expectedVersion: 1 };
        for (const [scopes, expected] of [
          [["memory:write"], false],
          [["settings:write"], true],
          [[], false],
        ] as const) {
          h.registry.set(grants(env), AsyncResult.success(sessionScopes(scopes)));
          expect(h.registry.get(h.memory.hubReconcile.permissionAtom(env, input))).toBe(expected);
          expect(h.registry.get(h.memory.hubReconcile.permissionAtom(other, input))).toBe(false);
        }
        expect(
          (yield* Effect.promise(() =>
            h.memory.hubReconcile.run(h.registry, { environmentId: env, input }),
          ))._tag,
        ).toBe("Failure");
      }),
    ),
  );

  it.effect(
    "import workflow uses the guarded command and rechecks the live destination grants",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const recovery = createMemoryImportRecoveryStore(
            { getItem: () => null, setItem: () => {}, removeItem: () => {} },
            () => 1000,
          );
          const workflow = h.memory.createImportWorkflow(h.registry, {
            fence: { environmentId: env, memorySpaceId: space, session: "connection" },
            recovery,
            operationId: () => MemoryOperationId.make("00000000-0000-4000-8000-000000000008"),
          });
          const phases: string[] = [];
          const unsubscribe = workflow.subscribe(() => phases.push(workflow.getSnapshot().phase));
          const result = yield* Effect.promise(() => workflow.discover("codex"));
          expect(phases).toEqual(["discovering", "discovered"]);
          expect(workflow.getSnapshot()).toBe(workflow.getState());
          unsubscribe();
          expect(result).toEqual({ action: "discover", sources: [] });
          expect(h.destinations).toEqual([env]);
          h.registry.set(grants(env), AsyncResult.success(sessionScopes(["memory:write"])));
          yield* Effect.promise(() =>
            expect(workflow.discover("codex")).rejects.toThrow("unavailable"),
          );
          expect(h.destinations).toEqual([env]);
          workflow.invalidate({ environmentId: other, memorySpaceId: space, session: "other" });
          yield* Effect.promise(() =>
            expect(workflow.discover("codex")).rejects.toThrow("unavailable"),
          );
          expect(h.destinations).toEqual([env]);
        }),
      ),
  );

  it.effect("report retry reset permission follows settings write on the exact environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const request = { memorySpaceId: space, environmentId: env, reportIds: ["a".repeat(64)] };
        h.registry.set(grants(env), AsyncResult.success(sessionScopes(["memory:write"])));
        expect(h.registry.get(h.memory.resetReportAttempts.permissionAtom(env, request))).toBe(
          false,
        );
        h.registry.set(grants(env), AsyncResult.success(sessionScopes(["settings:write"])));
        expect(h.registry.get(h.memory.resetReportAttempts.permissionAtom(env, request))).toBe(
          true,
        );
        expect(h.registry.get(h.memory.resetReportAttempts.permissionAtom(other, request))).toBe(
          false,
        );
        h.registry.set(grants(env), AsyncResult.success(sessionScopes([])));
        expect(h.registry.get(h.memory.resetReportAttempts.permissionAtom(env, request))).toBe(
          false,
        );
      }),
    ),
  );

  it.effect("allows core commands but rejects import on a core-only environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const coreOnlyConfig = {
          environment: { capabilities: { memory: { protocolVersion: 1 } } },
        } as ServerConfig;
        const coreReply = { settings: { mode: "disabled" as const }, version: 0, members: [] };
        const coreRequest = vi.fn(() => Effect.succeed(coreReply));
        const importRequest = vi.fn(h.rpc[WS_METHODS.memoryImportProvider]);
        yield* SubscriptionRef.set(
          h.active,
          Option.some({
            client: {
              ...h.rpc,
              [WS_METHODS.memoryHubSettingsGet]: coreRequest,
              [WS_METHODS.memoryImportProvider]: importRequest,
            },
            initialConfig: Effect.succeed(coreOnlyConfig),
          } as unknown as RpcSession),
        );
        h.registry.set(
          grants(env),
          AsyncResult.success(sessionScopes(["settings:write", "memory:write", "filesystem:read"])),
        );
        h.registry.set(configs(env), coreOnlyConfig);
        const importInput = {
          memorySpaceId: space,
          action: "discover" as const,
          format: "claude" as const,
        };
        expect(h.registry.get(h.memory.hubSettingsGet.permissionAtom(env, {}))).toBe(true);
        expect(h.registry.get(h.memory.importProvider.permissionAtom(env, importInput))).toBe(
          false,
        );
        const coreResult = yield* Effect.promise(() =>
          h.memory.hubSettingsGet.run(h.registry, { environmentId: env, input: {} }),
        );
        expect(coreResult._tag).toBe("Success");
        if (coreResult._tag === "Success") expect(coreResult.value).toEqual(coreReply);
        expect(coreRequest).toHaveBeenCalledExactlyOnceWith({});
        expect(
          (yield* Effect.promise(() =>
            h.memory.importProvider.run(h.registry, { environmentId: env, input: importInput }),
          ))._tag,
        ).toBe("Failure");
        expect(importRequest).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect.each(["reset", "forget", "invalidate"] as const)(
    "discards a delayed read after %s and clears derived edits only",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const edit = h.memory.draftAtom({ ...target, draftId: "edit" });
          const fresh = h.memory.draftAtom({ ...target, draftId: "new" });
          const otherEdit = h.memory.draftAtom({ ...target, draftId: "other-edit" });
          h.registry.mount(edit);
          h.registry.mount(fresh);
          h.registry.mount(otherEdit);
          h.registry.set(edit, { text: "Derived body", memoryIds: [id] });
          h.registry.set(fresh, { text: "New draft", memoryIds: [] });
          h.registry.set(otherEdit, {
            text: "Unrelated edit",
            memoryIds: [unrelated],
          });
          const source = h.memory.read(readTarget);
          const read = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
          h.registry.mount(read);
          yield* Deferred.await(h.readStarted);
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal(kind));
          yield* waitFor(h.registry, exposure, (state) => state !== before);
          expect(h.registry.get(edit)).toBeNull();
          expect(h.registry.get(fresh)).toBe("New draft");
          expect(h.registry.get(otherEdit)).toBe(kind === "invalidate" ? "Unrelated edit" : null);
          yield* Deferred.succeed(h.reply, item);
          yield* TestClock.adjust(0);
          expect(Option.isNone(h.registry.get(read))).toBe(true);
        }),
      ),
  );
  it.effect(
    "subscribes once, evicts visible bodies on disconnect, and waits for a fresh reset",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
          h.registry.mount(body);
          yield* Deferred.await(h.readStarted);
          yield* Deferred.succeed(h.reply, item);
          yield* waitFor(h.registry, body, Option.isSome);
          expect(h.subscriptions()).toBe(1);
          yield* SubscriptionRef.set(h.active, Option.none());
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(Option.isNone(h.registry.get(body))).toBe(true);
        }),
      ),
  );
  it.effect.each(["reset", "forget", "invalidate"] as const)(
    "evicts list/search/history/source and visible reads on %s",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const bodies = [
            hasBody(h.memory.read(readTarget)),
            hasBody(
              h.memory.list({
                ...target,
                input: { ...target.input, includeQuarantined: false, limit: 10 },
              }),
            ),
            hasBody(
              h.memory.search({
                ...target,
                input: { ...target.input, query: "Synthetic", mode: "fts", limit: 10 },
              }),
            ),
            hasBody(h.memory.history({ ...readTarget, input: { ...readTarget.input, limit: 10 } })),
            hasBody(
              h.memory.readSource({
                ...readTarget,
                input: {
                  ...readTarget.input,
                  limit: 10,
                  sourceThread: { environmentId: env, threadId: ThreadId.make("synthetic-thread") },
                  messageIds: [MessageId.make("m1")],
                },
              }),
            ),
          ];
          for (const body of bodies) h.registry.mount(body);
          yield* Deferred.succeed(h.reply, item);
          for (const body of bodies) yield* waitFor(h.registry, body, Boolean);
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal(kind));
          yield* waitFor(h.registry, exposure, (state) => state !== before);
          expect(bodies.map((body) => h.registry.get(body))).toEqual([
            false,
            false,
            false,
            false,
            false,
          ]);
        }),
      ),
  );
  it.effect.each(["downgrade", "remove", "prepared", "prepared-replaced", "failure"] as const)(
    "clears exposure and edits on %s",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const edit = h.memory.draftAtom({ ...target, draftId: "edit" });
          h.registry.mount(edit);
          h.registry.set(edit, { text: "Derived", memoryIds: [id] });
          if (reason === "downgrade")
            h.registry.set(grants(env), AsyncResult.success(sessionScopes([])));
          if (reason === "remove") yield* h.remove();
          if (reason === "prepared") h.registry.set(prepared(env), Option.none());
          if (reason === "prepared-replaced")
            h.registry.set(prepared(env), Option.some({} as PreparedConnection));
          if (reason === "failure")
            yield* Queue.offer(h.queue, new MemoryRpcError({ code: "bootstrap_required" }));
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(h.registry.get(edit)).toBeNull();
        }),
      ),
  );
  it.effect("expires a mounted body and forwards public refresh to a second RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const source = h.memory.read(readTarget);
        const body = Atom.make((get) => Option.flatten(AsyncResult.value(get(source))));
        h.registry.mount(body);
        yield* Deferred.await(h.readStarted);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Option.isSome);
        yield* TestClock.adjust("1 minute");
        yield* waitFor(h.registry, body, Option.isNone);
        expect(Option.isNone(h.registry.get(body))).toBe(true);
        expect(h.readCount()).toBe(1);
        yield* Queue.take(h.reads);
        h.registry.refresh(source);
        expect(Option.isNone(h.registry.get(body))).toBe(true);
        const second = yield* Queue.take(h.reads);
        expect(h.readCount()).toBe(2);
        yield* Deferred.succeed(second.reply, item);
        yield* waitFor(h.registry, body, Option.isSome);
      }),
    ),
  );
  it.effect("does not open a read stream for a write-only grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(grants(env), AsyncResult.success(sessionScopes(["memory:write"])));
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* TestClock.adjust(0);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.subscriptions()).toBe(0);
      }),
    ),
  );
  it.effect.each(["pending", "visible"] as const)(
    "closes %s body/draft immediately on transport failure with session/prepared retained",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const body = hasBody(source);
          h.registry.mount(body);
          yield* Deferred.await(h.readStarted);
          const edit = h.memory.draftAtom({ ...target, draftId: "transport-edit" });
          h.registry.mount(edit);
          h.registry.set(edit, { text: "Derived", memoryIds: [id] });
          if (phase === "visible") {
            yield* Deferred.succeed(h.reply, item);
            yield* waitFor(h.registry, body, Boolean);
          }
          const session = yield* SubscriptionRef.get(h.active);
          const connection = h.registry.get(prepared(env));
          yield* Queue.offer(
            h.queue,
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "synthetic transport closed",
                cause: new Error("synthetic"),
              }),
            }),
          );
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(h.registry.get(body)).toBe(false);
          expect(h.registry.get(edit)).toBeNull();
          expect(yield* SubscriptionRef.get(h.active)).toBe(session);
          expect(h.registry.get(prepared(env))).toBe(connection);
          yield* Deferred.await(h.readFinalized);
          yield* Deferred.succeed(h.reply, item);
          yield* TestClock.adjust(0);
          expect(h.registry.get(body)).toBe(false);
          // Recovery belongs to session lifecycle, and an upsert cannot replace reset.
          yield* SubscriptionRef.set(
            h.active,
            Option.some({
              client: h.rpc,
              initialConfig: Effect.succeed(config),
            } as unknown as RpcSession),
          );
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal("upsert", unrelated));
          yield* waitFor(h.registry, exposure, (state) => state !== before);
          expect(h.registry.get(exposure).ready).toBe(false);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          expect(h.registry.get(body)).toBe(false);
        }),
      ),
  );

  it.effect("retries a failed mounted public query and keeps the old body absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const source = h.memory.read(readTarget);
        h.registry.mount(source);
        const first = yield* Queue.take(h.reads);
        yield* Deferred.fail(first.reply, new MemoryRpcError({ code: "bootstrap_required" }));
        yield* waitFor(h.registry, source, (value) => value._tag === "Failure");
        h.registry.refresh(source);
        const second = yield* Queue.take(h.reads);
        expect(Option.isNone(Option.flatten(AsyncResult.value(h.registry.get(source))))).toBe(true);
        yield* Deferred.succeed(second.reply, item);
        yield* waitFor(h.registry, hasBody(source), Boolean);
        expect(h.readCount()).toBe(2);
      }),
    ),
  );

  it.effect("retains tombstones when weak-family closures are deterministically recreated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        const release = h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        yield* Queue.offer(h.queue, signal("forget"));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        release();
        yield* TestClock.adjust(0);
        // A fresh family guarantees fresh closures without relying on nondeterministic GC.
        const recreated = h.recreate();
        const next = recreated.exposureAtom(target);
        h.registry.mount(next);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, next, (state) => state.ready);
        const before = h.registry.get(next);
        yield* Queue.offer(h.queue, signal("upsert"));
        yield* waitFor(h.registry, next, (state) => state !== before);
        expect(memoryExposureMatches(h.registry.get(next), h.registry.get(next), [id])).toBe(false);
        const body = hasBody(recreated.read(readTarget));
        h.registry.mount(body);
        yield* TestClock.adjust(0);
        expect(h.readCount()).toBe(0);
        expect(h.registry.get(body)).toBe(false);
      }),
    ),
  );

  it("bounds ledger metadata without evicting tombstones until owner disposal", () => {
    const ledger = createMemoryTombstoneLedger(2, 1);
    const selected = ledger.space(env, space);
    ledger.forget(selected, id);
    expect(ledger.space(env, space)).toBe(selected);
    ledger.forget(selected, unrelated);
    expect(selected.blocked).toBe(true);
    expect(selected.forgotten.has(id)).toBe(true);
    expect(selected.forgotten.size).toBe(1);
    const foreign = ledger.space(other, space);
    expect(
      ledger.space(env, MemorySpaceId.make("00000000-0000-4000-8000-000000000010")).blocked,
    ).toBe(true);
    expect(ledger.space(env, space)).toBe(selected);
    expect(ledger.space(other, space)).toBe(foreign);
    ledger.dispose();
    expect(ledger.space(env, space)).not.toBe(selected);
    expect(ledger.space(env, space).forgotten.size).toBe(0);
    expect(ledger.space(env, space).blocked).toBe(true);
    expect(ledger.space(other, space)).not.toBe(foreign);
  });

  it.effect("factory disposal closes mounted exposure, body and derived draft", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Boolean);
        const edit = h.memory.draftAtom({ ...target, draftId: "dispose" });
        h.registry.mount(edit);
        h.registry.set(edit, { text: "Derived", memoryIds: [id] });
        h.memory.dispose(h.registry);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(body)).toBe(false);
        expect(h.registry.get(edit)).toBeNull();
      }),
    ),
  );

  it.effect("other ID changes preserve direct read/history/source while invalidating pages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const bodies = [
          hasBody(h.memory.read(readTarget)),
          hasBody(h.memory.history({ ...readTarget, input: { ...readTarget.input, limit: 10 } })),
          hasBody(
            h.memory.readSource({
              ...readTarget,
              input: {
                ...readTarget.input,
                limit: 10,
                sourceThread: { environmentId: env, threadId: ThreadId.make("synthetic-thread") },
                messageIds: [MessageId.make("m1")],
              },
            }),
          ),
          hasBody(
            h.memory.list({
              ...target,
              input: { ...target.input, includeQuarantined: false, limit: 10 },
            }),
          ),
          hasBody(
            h.memory.search({
              ...target,
              input: { ...target.input, query: "Synthetic", mode: "fts", limit: 10 },
            }),
          ),
        ];
        for (const body of bodies) h.registry.mount(body);
        yield* Deferred.succeed(h.reply, item);
        for (const body of bodies) yield* waitFor(h.registry, body, Boolean);
        const before = h.registry.get(exposure);
        yield* Queue.offer(h.queue, signal("upsert", unrelated));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(bodies.map((body) => h.registry.get(body))).toEqual([
          true,
          true,
          true,
          false,
          false,
        ]);
        expect(h.readCount()).toBe(1);
      }),
    ),
  );

  it.effect("signals from another environment preserve selected bodies and derived drafts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(grants(other), AsyncResult.success(sessionScopes(["memory:read"])));
        const selected = h.memory.exposureAtom(target);
        const foreign = h.memory.exposureAtom({ ...target, environmentId: other });
        h.registry.mount(selected);
        h.registry.mount(foreign);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* Queue.offer(h.otherQueue, signal("reset"));
        yield* waitFor(h.registry, selected, (state) => state.ready);
        yield* waitFor(h.registry, foreign, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Boolean);
        const edit = h.memory.draftAtom({ ...target, draftId: "selected" });
        h.registry.mount(edit);
        h.registry.set(edit, { text: "Selected derived", memoryIds: [id] });
        const before = h.registry.get(foreign);
        yield* Queue.offer(h.otherQueue, signal("forget"));
        yield* waitFor(h.registry, foreign, (state) => state !== before);
        expect(h.registry.get(body)).toBe(true);
        expect(h.registry.get(edit)).toBe("Selected derived");
        expect(h.readCount()).toBe(1);
      }),
    ),
  );

  it.effect("replacing Some(prepared) requires reset and cancels the old pending body", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.await(h.readStarted);
        h.registry.set(prepared(env), Option.some({} as PreparedConnection));
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        yield* Deferred.await(h.readFinalized);
        yield* Deferred.succeed(h.reply, item);
        const before = h.registry.get(exposure);
        yield* Queue.offer(h.queue, signal("upsert"));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(body)).toBe(false);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        expect(h.registry.get(body)).toBe(false);
      }),
    ),
  );

  it.effect("session replacement fences old signals and late body until a new reset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* Deferred.await(h.readStarted);
        const nextQueue = yield* Queue.unbounded<MemoryChangeSignal>();
        yield* SubscriptionRef.set(
          h.active,
          Option.some({
            client: { ...h.rpc, [WS_METHODS.memoryChanges]: () => Stream.fromQueue(nextQueue) },
            initialConfig: Effect.succeed(config),
          } as unknown as RpcSession),
        );
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        yield* Deferred.await(h.readFinalized);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* Queue.offer(h.queue, signal("forget"));
        yield* Deferred.succeed(h.reply, item);
        const before = h.registry.get(exposure);
        yield* Queue.offer(nextQueue, signal("upsert", unrelated));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(false);
        expect(h.registry.get(body)).toBe(false);
        yield* Queue.offer(nextQueue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        expect(h.registry.get(body)).toBe(false);
      }),
    ),
  );

  it.effect("losing only orchestration:read clears source but preserves memory read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(h.memory.read(readTarget));
        const source = hasBody(
          h.memory.readSource({
            ...readTarget,
            input: {
              ...readTarget.input,
              limit: 10,
              sourceThread: { environmentId: env, threadId: ThreadId.make("synthetic-thread") },
              messageIds: [MessageId.make("m1")],
            },
          }),
        );
        h.registry.mount(body);
        h.registry.mount(source);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Boolean);
        yield* waitFor(h.registry, source, Boolean);
        h.registry.set(
          grants(env),
          AsyncResult.success(sessionScopes(["memory:read", "memory:write", "filesystem:read"])),
        );
        expect(h.registry.get(source)).toBe(false);
        expect(h.registry.get(body)).toBe(true);
        expect(h.registry.get(exposure).ready).toBe(true);
      }),
    ),
  );

  it.effect("missing memory capability starts neither a body request nor a changes stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(configs(env), { environment: { capabilities: {} } } as ServerConfig);
        const body = hasBody(h.memory.read(readTarget));
        h.registry.mount(body);
        yield* TestClock.adjust(0);
        expect(h.registry.get(body)).toBe(false);
        expect(h.subscriptions()).toBe(0);
        expect(h.readCount()).toBe(0);
      }),
    ),
  );

  it.effect.each(["timeout", "unmount"] as const)(
    "interrupts the actual pending RPC finalizer on %s",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const release = h.registry.mount(source);
          yield* Deferred.await(h.readStarted);
          if (reason === "timeout") yield* TestClock.adjust("1 minute");
          else {
            release();
            yield* TestClock.adjust(0);
          }
          yield* Deferred.await(h.readFinalized);
          yield* Deferred.succeed(h.reply, item);
          if (reason === "timeout")
            expect(Option.isNone(Option.flatten(AsyncResult.value(h.registry.get(source))))).toBe(
              true,
            );
        }),
      ),
  );
  it.effect("ledger overflow stays closed across reset without forgetting earlier tombstones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(createMemoryTombstoneLedger(2, 1));
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        yield* Queue.offer(h.queue, signal("forget"));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        yield* Queue.offer(h.queue, signal("forget", unrelated));
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        const before = h.registry.get(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state !== before);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(true);
      }),
    ),
  );
  it.effect("unready and ready empty catalogs preserve an existing ledger", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const retained = h.ledger.space(env, space);
        h.ledger.forget(retained, id);
        const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
        catalogOverrides.set(h.runtime, catalog);
        const recreated = h.recreate();
        const exposure = recreated.exposureAtom(target);
        h.registry.mount(exposure);
        expect(h.registry.get(exposure).ready).toBe(false);
        expect(h.ledger.space(env, space)).toBe(retained);
        expect(retained.forgotten.has(id)).toBe(true);
        h.registry.set(catalog, { isReady: true, entries: yield* SubscriptionRef.get(h.entries) });
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(true);
        const body = hasBody(recreated.read(readTarget));
        h.registry.mount(body);
        expect(h.registry.get(body)).toBe(false);
        h.registry.set(catalog, { isReady: true, entries: new Map() });
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        expect(h.ledger.space(env, space)).toBe(retained);
        expect(retained.forgotten.has(id)).toBe(true);
      }),
    ),
  );

  it.effect.each(["pending", "visible"] as const)(
    "ready catalog absence closes %s body/draft but preserves forget through recovery",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          yield* Queue.offer(h.queue, signal("forget"));
          yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
          const retained = h.ledger.space(env, space);
          const foreign = h.ledger.space(other, space);
          h.ledger.forget(foreign, unrelated);
          const body = hasBody(
            h.memory.read({
              ...readTarget,
              input: { ...readTarget.input, memoryId: unrelated },
            }),
          );
          h.registry.mount(body);
          const first = yield* Queue.take(h.reads);
          const edit = h.memory.draftAtom({ ...target, draftId: "catalog-absence" });
          h.registry.mount(edit);
          h.registry.set(edit, { text: "Derived before absence", memoryIds: [unrelated] });
          if (phase === "visible") {
            yield* Deferred.succeed(first.reply, unrelatedItem);
            yield* waitFor(h.registry, body, Boolean);
          }
          const entries = yield* SubscriptionRef.get(h.entries);
          // Model a ready platform reconciliation that drops only the expired backend.
          yield* SubscriptionRef.set(h.entries, new Map([[other, entries.get(other)!]]));
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(h.registry.get(body)).toBe(false);
          expect(h.registry.get(edit)).toBeNull();
          expect(h.ledger.space(env, space)).toBe(retained);
          expect(retained.forgotten.has(id)).toBe(true);
          yield* Deferred.await(first.finalized);
          yield* Deferred.succeed(first.reply, unrelatedItem);
          expect(h.registry.get(body)).toBe(false);
          // Removing a different registration must not clean the retained E ledger either.
          yield* SubscriptionRef.set(h.entries, new Map());
          expect(h.registry.get(exposure).ready).toBe(false);
          expect(h.ledger.space(env, space)).toBe(retained);
          expect(h.ledger.space(other, space)).toBe(foreign);
          yield* SubscriptionRef.set(h.entries, entries);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal("upsert"));
          yield* waitFor(h.registry, exposure, (state) => state !== before);
          expect(h.registry.get(exposure).forgotten.has(id)).toBe(true);
          expect(
            memoryExposureMatches(h.registry.get(exposure), h.registry.get(exposure), [id]),
          ).toBe(false);
          const restoredRead = yield* Queue.take(h.reads);
          const forgottenBody = hasBody(h.memory.read(readTarget));
          h.registry.mount(forgottenBody);
          const list = h.memory.list({
            ...target,
            input: { ...target.input, limit: 10, includeQuarantined: false },
          });
          h.registry.mount(list);
          yield* Deferred.succeed(restoredRead.reply, unrelatedItem);
          yield* waitFor(
            h.registry,
            list,
            (result) => result._tag === "Success" && Option.isSome(result.value),
          );
          expect(h.registry.get(forgottenBody)).toBe(false);
          const result = h.registry.get(list);
          if (result._tag !== "Success" || Option.isNone(result.value))
            throw new Error("Page required");
          expect(result.value.value.items).toEqual([]);
          expect(h.readCount()).toBe(2);
          expect(h.registry.get(edit)).toBeNull();
          h.memory.dispose(h.registry);
          expect(h.registry.get(body)).toBe(false);
          expect(h.ledger.space(env, space)).not.toBe(retained);
          expect(h.ledger.space(env, space).forgotten.size).toBe(0);
          expect(h.ledger.space(env, space).blocked).toBe(true);
        }),
      ),
  );

  it.effect.each(["pending", "visible"] as const)(
    "version 10000/10001 boundary fences %s body/draft and resumes only after reset",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exposure = h.memory.exposureAtom(target);
          h.registry.mount(exposure);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const source = h.memory.read(readTarget);
          const body = hasBody(source);
          h.registry.mount(body);
          const first = yield* Queue.take(h.reads);
          const edit = h.memory.draftAtom({ ...target, draftId: "version-limit" });
          h.registry.mount(edit);
          h.registry.set(edit, { text: "Derived before overflow", memoryIds: [id] });
          if (phase === "visible") {
            yield* Deferred.succeed(first.reply, item);
            yield* waitFor(h.registry, body, Boolean);
          }
          const changes = Array.from({ length: 10_000 }, (_, index) =>
            signal(
              "upsert",
              MemoryId.make(`10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`),
            ),
          );
          yield* Queue.offerAll(h.queue, changes);
          yield* waitFor(h.registry, exposure, (state) => HashMap.size(state.versions) === 10_000);
          expect(h.registry.get(exposure).ready).toBe(true);
          expect(h.registry.get(edit)).toBe("Derived before overflow");
          expect(h.readCount()).toBe(1);
          expect(h.registry.get(body)).toBe(phase === "visible");
          const before = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal("upsert", unrelated));
          yield* waitFor(h.registry, exposure, (state) => !state.ready);
          expect(HashMap.size(h.registry.get(exposure).versions)).toBe(0);
          expect(h.registry.get(exposure).epoch).not.toBe(before.epoch);
          expect(h.registry.get(body)).toBe(false);
          expect(h.registry.get(edit)).toBeNull();
          yield* Deferred.await(first.finalized);
          yield* Deferred.succeed(first.reply, item);
          const closed = h.registry.get(exposure);
          yield* Queue.offer(h.queue, signal("upsert", unrelated));
          yield* waitFor(h.registry, exposure, (state) => state !== closed);
          expect(h.registry.get(exposure).ready).toBe(false);
          expect(h.registry.get(body)).toBe(false);
          expect(h.readCount()).toBe(1);
          yield* Queue.offer(h.queue, signal("reset"));
          yield* waitFor(h.registry, exposure, (state) => state.ready);
          const second = yield* Queue.take(h.reads);
          expect(h.registry.get(body)).toBe(false);
          expect(h.registry.get(edit)).toBeNull();
          expect(HashMap.size(h.registry.get(exposure).versions)).toBe(0);
          yield* Deferred.succeed(second.reply, item);
          yield* waitFor(h.registry, body, Boolean);
          expect(h.readCount()).toBe(2);
          expect(h.registry.get(edit)).toBeNull();
        }),
      ),
  );
});

it.effect.each([
  ["list", true],
  ["list", false],
  ["search", true],
  ["search", false],
] as const)(
  "keeps unrelated %s records after forget without exposing forgotten or derived text (source present: %s)",
  ([method, sourcePresent]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const derivedId = MemoryId.make("00000000-0000-4000-8000-000000000009");
        if (unrelatedItem.status !== "active" || item.status !== "active")
          throw new Error("Active fixture required");
        const derived = {
          ...unrelatedItem,
          memoryId: derivedId,
          revision: { ...unrelatedItem.revision, memoryId: derivedId },
          payload: {
            ...unrelatedItem.payload,
            text: "Derived forgotten text",
            derivedFromMemoryRevisions: [item.revision.revisionId],
          },
        };
        const stalePage = yield* decodeMemoryPage(
          {
            ...page,
            nextCursor: "next-page",
            items: [...(sourcePresent ? [item] : []), unrelatedItem, derived],
          },
          { onExcessProperty: "error" },
        );
        const h = yield* harness(createMemoryTombstoneLedger(), stalePage, true);
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        yield* Queue.offer(h.queue, signal("forget"));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        const query =
          method === "list"
            ? h.memory.list({
                ...target,
                input: { ...target.input, includeQuarantined: false, limit: 10 },
              })
            : h.memory.search({
                ...target,
                input: { ...target.input, query: "Synthetic", mode: "fts", limit: 10 },
              });
        h.registry.mount(query);
        yield* Deferred.succeed(h.reply, item);
        const result = yield* waitFor(
          h.registry,
          query,
          (value) => value._tag === "Success" && Option.isSome(value.value),
        );
        expect(Option.isSome(result)).toBe(true);
        const value = h.registry.get(query);
        if (value._tag !== "Success" || Option.isNone(value.value))
          throw new Error("Page required");
        expect(value.value.value.items.map((entry) => entry.memoryId)).toEqual([unrelated]);
        expect(value.value.value.nextCursor).toBe("next-page");
        expect(JSON.stringify(value.value.value)).not.toContain("Derived forgotten text");
        // Reconnection/reset still cannot authorize unknown revision dependencies.
        h.registry.set(prepared(env), Option.some({} as PreparedConnection));
        yield* waitFor(h.registry, exposure, (state) => !state.ready);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, query, (r) => r._tag === "Success" && Option.isSome(r.value));
        const afterReset = h.registry.get(query);
        if (afterReset._tag !== "Success" || Option.isNone(afterReset.value))
          throw new Error("Page required");
        expect(afterReset.value.value.items.map((entry) => entry.memoryId)).toEqual([unrelated]);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(true);
      }),
    ),
);

it.effect("keeps schema-decoded forgotten rows visible after observing the same forget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tombstone = {
        memorySpaceId: space,
        memoryId: id,
        deleteOperationId: "00000000-0000-4000-8000-000000000007",
        deletingEnvironmentId: env,
        deletedAtUtc: "2026-10-15T00:00:00.000Z",
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      };
      const forgottenPage = yield* decodeMemoryPage(
        {
          ...page,
          items: [
            {
              memorySpaceId: space,
              memoryId: id,
              status: "forgotten",
              pendingSync: false,
              localAvailability: {
                exposure: "forgotten",
                reasons: [],
                deferred: [],
                cleanupPending: false,
              },
              tombstone,
            },
            unrelatedItem,
          ],
        },
        { onExcessProperty: "error" },
      );
      const h = yield* harness(createMemoryTombstoneLedger(), forgottenPage);
      const exposure = h.memory.exposureAtom(target);
      h.registry.mount(exposure);
      yield* Queue.offer(h.queue, signal("reset"));
      yield* waitFor(h.registry, exposure, (state) => state.ready);
      yield* Queue.offer(h.queue, signal("forget"));
      yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
      const query = h.memory.list({
        ...target,
        input: { ...target.input, includeQuarantined: false, limit: 10 },
      });
      h.registry.mount(query);
      yield* Deferred.succeed(h.reply, item);
      yield* waitFor(h.registry, query, (r) => r._tag === "Success" && Option.isSome(r.value));
      const result = h.registry.get(query);
      if (result._tag !== "Success" || Option.isNone(result.value))
        throw new Error("Page required");
      expect(result.value.value.items.map((entry) => entry.status)).toEqual([
        "forgotten",
        "active",
      ]);
      expect(result.value.value.items[0]).toEqual(forgottenPage.items[0]);
      expect(result.value.value.items[0]).not.toHaveProperty("payload");
    }),
  ),
);

it.effect.each(["read", "history", "draft"] as const)(
  "removes already open derived %s when only its source is forgotten",
  (consumer) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (item.status !== "active" || unrelatedItem.status !== "active")
          throw new Error("Active fixture required");
        const derived = yield* decodeMemoryItem(
          {
            ...unrelatedItem,
            revision: {
              ...unrelatedItem.revision,
              revisionId: "00000000-0000-4000-8000-000000000009",
              payloadRef: "00000000-0000-4000-8000-000000000009",
            },
            payload: {
              ...unrelatedItem.payload,
              text: "Already open derivative",
              derivedFromMemoryRevisions: [item.revision.revisionId],
            },
          },
          { onExcessProperty: "error" },
        );
        if (derived.status !== "active") throw new Error("Active fixture required");
        const derivedHistory = yield* decodeMemoryHistory(
          {
            ...history,
            memoryId: derived.memoryId,
            revisions: [{ revision: derived.revision, payload: derived.payload }],
          },
          { onExcessProperty: "error" },
        );
        const h = yield* harness(createMemoryTombstoneLedger(), page, false, derivedHistory);
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const derivedTarget = { ...target, input: { ...target.input, memoryId: derived.memoryId } };
        const read = h.memory.read(derivedTarget);
        const past = h.memory.history({
          ...derivedTarget,
          input: { ...derivedTarget.input, limit: 10 },
        });
        h.registry.mount(read);
        h.registry.mount(past);
        yield* Deferred.succeed(h.reply, derived);
        yield* waitFor(h.registry, hasBody(read), Boolean);
        yield* waitFor(h.registry, hasBody(past), Boolean);
        expect(JSON.stringify(h.registry.get(read))).toContain("Already open derivative");
        expect(JSON.stringify(h.registry.get(past))).toContain("Already open derivative");
        const edit = h.memory.draftAtom({ ...target, draftId: "open-derivative" });
        h.registry.mount(edit);
        h.registry.set(edit, { text: derived.payload.text, memoryIds: [derived.memoryId] });
        expect(h.registry.get(edit)).toBe("Already open derivative");
        yield* Queue.offer(h.queue, signal("forget", id));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        // No D signal, refetch, TTL advance, or new mount is needed to purge the body.
        if (consumer === "read")
          expect(h.registry.get(read)).toMatchObject({ _tag: "Success", value: Option.none() });
        if (consumer === "history")
          expect(h.registry.get(past)).toMatchObject({ _tag: "Success", value: Option.none() });
        if (consumer === "draft") expect(h.registry.get(edit)).toBeNull();
        expect(h.readCount()).toBe(1);
      }),
    ),
);

it.effect("closes even an independent open detail and edit after another memory is forgotten", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (unrelatedItem.status !== "active") throw new Error("Active fixture required");
      const h = yield* harness();
      const exposure = h.memory.exposureAtom(target);
      h.registry.mount(exposure);
      yield* Queue.offer(h.queue, signal("reset"));
      yield* waitFor(h.registry, exposure, (state) => state.ready);
      const read = h.memory.read({ ...target, input: { ...target.input, memoryId: unrelated } });
      const body = hasBody(read);
      h.registry.mount(body);
      yield* Deferred.succeed(h.reply, unrelatedItem);
      yield* waitFor(h.registry, body, Boolean);
      const edit = h.memory.draftAtom({ ...target, draftId: "independent" });
      h.registry.mount(edit);
      h.registry.set(edit, {
        text: unrelatedItem.payload.text,
        memoryIds: [unrelated],
      });
      yield* Queue.offer(h.queue, signal("forget", id));
      yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
      expect(h.registry.get(body)).toBe(false);
      expect(h.registry.get(edit)).toBeNull();
      expect(h.readCount()).toBe(1);
    }),
  ),
);

it.effect.each(["read", "history", "source", "draft"] as const)(
  "fences inherited empty-lineage %s on source-only forget",
  (consumer) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (item.status !== "active" || unrelatedItem.status !== "active")
          throw new Error("Active fixture required");
        const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
        const d0 = yield* decodeMemoryItem(
          {
            ...unrelatedItem,
            revision: { ...unrelatedItem.revision, revisionId: uuid(9), payloadRef: uuid(9) },
            payload: {
              ...unrelatedItem.payload,
              text: "Inherited private summary",
              derivedFromMemoryRevisions: [item.revision.revisionId],
            },
          },
          { onExcessProperty: "error" },
        );
        if (d0.status !== "active") throw new Error("Active fixture required");
        const d1 = yield* decodeMemoryItem(
          {
            ...d0,
            revision: {
              ...d0.revision,
              revisionId: uuid(10),
              payloadRef: uuid(10),
              parents: [d0.revision.revisionId],
            },
            payload: { ...d0.payload, derivedFromMemoryRevisions: [] },
          },
          { onExcessProperty: "error" },
        );
        if (d1.status !== "active") throw new Error("Active fixture required");
        const judgments = yield* decodeMemoryHistory(
          {
            ...history,
            memoryId: d1.memoryId,
            revisions: [],
            resolutions: [
              {
                resolution: {
                  resolutionId: uuid(11),
                  memorySpaceId: space,
                  memoryId: d1.memoryId,
                  inputRevisionIds: [d0.revision.revisionId, uuid(12)],
                  inputPayloadRefs: [d0.revision.payloadRef, uuid(12)],
                  judgmentRef: uuid(11),
                  requestedModelSelection: { instanceId: "codex", model: "synthetic", options: [] },
                  effectiveProvider: "codex",
                  effectiveModel: "synthetic",
                  resolvingEnvironmentId: env,
                  fencingToken: 1,
                  resultRevisionId: d1.revision.revisionId,
                  appliedAtUtc: "2026-10-14T00:00:00.000Z",
                  revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
                },
                payload: { resolutionId: uuid(11), judgment: "Inherited private judgment" },
              },
            ],
          },
          { onExcessProperty: "error" },
        );
        const h = yield* harness(createMemoryTombstoneLedger(), page, false, judgments);
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const direct = { ...readTarget, input: { ...readTarget.input, memoryId: d1.memoryId } };
        const read = h.memory.read(direct);
        const past = h.memory.history({ ...direct, input: { ...direct.input, limit: 10 } });
        const source = h.memory.readSource({
          ...direct,
          input: {
            ...direct.input,
            sourceThread: sourcePage.sourceThread,
            messageIds: [MessageId.make("m1")],
            limit: 10,
          },
        });
        for (const body of [hasBody(read), hasBody(past), hasBody(source)]) h.registry.mount(body);
        yield* Deferred.succeed(h.reply, d1);
        for (const body of [hasBody(read), hasBody(past), hasBody(source)])
          yield* waitFor(h.registry, body, Boolean);
        expect(JSON.stringify(h.registry.get(read))).toContain("Inherited private summary");
        expect(JSON.stringify(h.registry.get(past))).toContain("Inherited private judgment");
        expect(JSON.stringify(h.registry.get(source))).toContain("Synthetic source");
        const edit = h.memory.draftAtom({ ...target, draftId: "inherited-empty" });
        h.registry.mount(edit);
        h.registry.set(edit, {
          text: d1.payload.text,
          memoryIds: [d1.memoryId],
          // An older consumer may still send this hint. Empty lineage is not proof.
          hasRevisionDependencies: d1.payload.derivedFromMemoryRevisions.length > 0,
        });
        expect(h.registry.get(edit)).toBe("Inherited private summary");
        yield* Queue.offer(h.queue, signal("forget", id));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        // Only A changes. No D signal, refresh, TTL advance, or remount.
        if (consumer === "draft") expect(h.registry.get(edit)).toBeNull();
        else {
          const visible = {
            read: h.registry.get(hasBody(read)),
            history: h.registry.get(hasBody(past)),
            source: h.registry.get(hasBody(source)),
          };
          expect(visible[consumer]).toBe(false);
        }
        expect(h.readCount()).toBe(1);
      }),
    ),
);

it.effect.each(
  (["read", "history", "source"] as const).flatMap((consumer) =>
    (["refresh", "reopen", "reset-reopen"] as const).map((restart) => ({ consumer, restart })),
  ),
)(
  "admits post-stream-forget $consumer on $restart with a fresh request generation",
  ({ consumer, restart }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const independentHistory = yield* decodeMemoryHistory({
          ...history,
          memoryId: unrelated,
          revisions: [],
        });
        const h = yield* harness(createMemoryTombstoneLedger(), page, true, independentHistory);
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const direct = { ...target, input: { ...target.input, memoryId: unrelated } };
        const query: Atom.Atom<AsyncResult.AsyncResult<Option.Option<unknown>, unknown>> =
          consumer === "read"
            ? h.memory.read(direct)
            : consumer === "history"
              ? h.memory.history({ ...direct, input: { ...direct.input, limit: 10 } })
              : h.memory.readSource({
                  ...direct,
                  input: {
                    ...direct.input,
                    sourceThread: sourcePage.sourceThread,
                    messageIds: [MessageId.make("m1")],
                    limit: 10,
                  },
                });
        let release = h.registry.mount(query);
        yield* Deferred.succeed(h.reply, unrelatedItem);
        yield* waitFor(h.registry, hasBody(query), Boolean);
        if (consumer === "read") yield* Queue.take(h.reads);
        // A different client forgets X; this client performs no mutation or refresh.
        yield* Queue.offer(h.queue, signal("forget", id));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        expect(h.registry.get(hasBody(query))).toBe(false);
        expect(h.readCount()).toBe(consumer === "read" ? 1 : 0);
        if (restart === "refresh") h.registry.refresh(query);
        else {
          release();
          yield* TestClock.adjust(0);
          if (restart === "reset-reopen") {
            const before = h.registry.get(exposure);
            yield* Queue.offer(h.queue, signal("reset"));
            yield* waitFor(
              h.registry,
              exposure,
              (state) => state.epoch !== before.epoch && state.ready,
            );
          }
          release = h.registry.mount(query);
        }
        if (consumer === "read") {
          const next = yield* Queue.take(h.reads);
          yield* Deferred.succeed(next.reply, unrelatedItem);
          yield* Deferred.await(next.finalized);
        }
        // Await the actual successful RPC result, then assert admission independently.
        // A stale generation must fail an assertion, rather than hang waiting for a body.
        yield* TestClock.adjust(0);
        const result = h.registry.get(query);
        expect(result._tag).toBe("Success");
        expect(Option.isSome(Option.flatten(AsyncResult.value(result)))).toBe(true);
        expect(h.registry.get(exposure).forgotten.has(id)).toBe(true);
        release();
      }),
    ),
);

it.effect("blocks a pre-stream-forget late read but admits the explicit retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      const exposure = h.memory.exposureAtom(target);
      h.registry.mount(exposure);
      yield* Queue.offer(h.queue, signal("reset"));
      yield* waitFor(h.registry, exposure, (state) => state.ready);
      const query = h.memory.read({ ...target, input: { ...target.input, memoryId: unrelated } });
      h.registry.mount(query);
      const first = yield* Queue.take(h.reads);
      yield* Queue.offer(h.queue, signal("forget", id));
      yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
      yield* Deferred.succeed(first.reply, unrelatedItem);
      yield* Deferred.await(first.finalized);
      expect(h.registry.get(hasBody(query))).toBe(false);
      expect(h.readCount()).toBe(1);
      h.registry.refresh(query);
      const second = yield* Queue.take(h.reads);
      yield* Deferred.succeed(second.reply, unrelatedItem);
      yield* Deferred.await(second.finalized);
      yield* TestClock.adjust(0);
      expect(h.registry.get(hasBody(query))).toBe(true);
    }),
  ),
);

it.effect(
  "blocks forgotten and explicitly derived direct reads after a stream forget and reset",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        if (item.status !== "active" || unrelatedItem.status !== "active")
          throw new Error("Active fixture required");
        const derived = yield* decodeMemoryItem(
          {
            ...unrelatedItem,
            payload: {
              ...unrelatedItem.payload,
              derivedFromMemoryRevisions: [item.revision.revisionId],
            },
          },
          { onExcessProperty: "error" },
        );
        const h = yield* harness();
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        yield* Queue.offer(h.queue, signal("forget", id));
        yield* waitFor(h.registry, exposure, (state) => state.forgotten.has(id));
        const before = h.registry.get(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.epoch !== before.epoch);
        const forgotten = h.memory.read(readTarget);
        h.registry.mount(forgotten);
        yield* TestClock.adjust(0);
        expect(h.registry.get(hasBody(forgotten))).toBe(false);
        expect(h.readCount()).toBe(0);
        const query = h.memory.read({ ...target, input: { ...target.input, memoryId: unrelated } });
        h.registry.mount(query);
        const response = yield* Queue.take(h.reads);
        yield* Deferred.succeed(response.reply, derived);
        yield* Deferred.await(response.finalized);
        expect(h.registry.get(hasBody(query))).toBe(false);
        expect(h.readCount()).toBe(1);
      }),
    ),
);

it.effect.each([
  { advertised: undefined, dispatched: undefined },
  { advertised: false, dispatched: false },
  { advertised: true, dispatched: true },
  { advertised: true, dispatched: undefined },
])(
  "history gates refused opt-in on atom and dispatch capabilities: %s",
  ({ advertised: supported, dispatched }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.registry.set(configs(env), {
          ...config,
          environment: {
            ...config.environment,
            capabilities: {
              memory: {
                protocolVersion: 1,
                ...(supported === undefined ? {} : { refusedReverts: supported }),
              },
            },
          },
        } as ServerConfig);
        yield* SubscriptionRef.set(
          h.active,
          Option.some({
            client: h.rpc,
            initialConfig: Effect.succeed({
              ...config,
              environment: {
                ...config.environment,
                capabilities: {
                  memory: {
                    protocolVersion: 1,
                    ...(dispatched === undefined ? {} : { refusedReverts: dispatched }),
                  },
                },
              },
            } as ServerConfig),
          } as unknown as RpcSession),
        );
        const exposure = h.memory.exposureAtom(target);
        h.registry.mount(exposure);
        yield* Queue.offer(h.queue, signal("reset"));
        yield* waitFor(h.registry, exposure, (state) => state.ready);
        const body = hasBody(
          h.memory.history({
            ...readTarget,
            input: { ...readTarget.input, limit: 10, includeRefusedReverts: true },
          }),
        );
        h.registry.mount(body);
        yield* Deferred.succeed(h.reply, item);
        yield* waitFor(h.registry, body, Boolean);
        expect(h.historyInputs).toEqual([
          {
            ...readTarget.input,
            limit: 10,
            ...(supported && dispatched ? { includeRefusedReverts: true } : {}),
          },
        ]);
      }),
    ),
);

// Direct helper callers bypass atom opt-in and still use the selected session gate.
it.effect("direct history helper strips caller opt-in for an unsupported session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Deferred.succeed(h.reply, item);
      const input = { ...readTarget.input, limit: 10, includeRefusedReverts: true as const };
      yield* requestMemoryQuery(h.runtime, h.registry, env, WS_METHODS.memoryHistory, input).pipe(
        Effect.provideService(EnvironmentRegistry, h.environments),
      );
      expect(h.historyInputs).toEqual([{ ...readTarget.input, limit: 10 }]);
      expect(input.includeRefusedReverts).toBe(true);
    }),
  ),
);
