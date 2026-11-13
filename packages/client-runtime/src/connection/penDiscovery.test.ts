import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type DesktopPenMember } from "@goat/contracts";
import * as Option from "effect/Option";
import { SshConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { SshConnectionTarget } from "./model.ts";
import { penRouteConnectionId } from "./routes.ts";
import { reconcilePenRoutes } from "./penDiscovery.ts";

const layer = discoveryLayer.pipe(Layer.provide(liveSetLayer));

const mesh = "a".repeat(26);
const otherMesh = "b".repeat(26);
const node = (letter: string) => letter.repeat(26);
const member = (letter: string): DesktopPenMember => ({
  nodeId: node(letter),
  name: letter,
  online: true,
  noisePub: letter,
  route: {
    kind: "trusted",
    target: {
      alias: `pen-${node(letter)}`,
      hostname: `pen-${node(letter)}`,
      username: null,
      port: null,
    },
    revision: "1",
  },
});
const entry = (id: string, alias: string): ConnectionCatalogEntry => {
  const environmentId = EnvironmentId.make(id);
  return {
    enabled: true,
    target: new SshConnectionTarget({ environmentId, connectionId: id, label: id }),
    profile: Option.some(
      new SshConnectionProfile({
        environmentId,
        connectionId: id,
        label: id,
        target: { alias, hostname: alias, username: null, port: null },
      }),
    ),
  };
};

describe("reconcilePenRoutes", () => {
  it("removes departed, refused, and other mesh routes and keeps owned routes separate", () => {
    const managed = member("c");
    const yours = member("d");
    const candidate = member("e");
    const refused: DesktopPenMember = {
      ...member("f"),
      route: { kind: "refused", reason: "key-mismatch" },
    };
    // Its ssh settings could not be read just now: not a departure, so its route stays.
    const unread: DesktopPenMember = {
      ...member("i"),
      route: { kind: "refused", reason: "unreadable" },
    };
    const unreadId = penRouteConnectionId(mesh, unread.nodeId);
    const managedId = penRouteConnectionId(mesh, managed.nodeId);
    const departed = penRouteConnectionId(mesh, node("g"));
    const foreign = penRouteConnectionId(otherMesh, node("h"));
    const refusedId = penRouteConnectionId(mesh, refused.nodeId);
    const result = reconcilePenRoutes({
      meshId: mesh,
      members: [managed, yours, candidate, refused, unread],
      existing: [
        entry(managedId, "x"),
        entry(departed, "x"),
        entry(foreign, "x"),
        entry(refusedId, "x"),
        entry(unreadId, "x"),
        entry("own", `pen-${yours.nodeId}`),
      ],
    });
    expect(result.remove.map((item) => item.routeId)).toEqual([departed, foreign, refusedId]);
    expect(result.managed.get(managed.nodeId)).toEqual(EnvironmentId.make(managedId));
    expect(result.yours.get(yours.nodeId)).toEqual(EnvironmentId.make("own"));
    expect(result.candidates).toEqual([candidate]);
  });
});

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { layer as discoveryLayer, PenDiscovery } from "./penDiscovery.ts";
import { layer as liveSetLayer, PenLiveSet } from "./penLiveSet.ts";
import { PenMembership } from "./penMembership.ts";
import { ConnectionOnboarding, type SshConnectionInput } from "./onboarding.ts";
import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "./registry.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import type { PenMembersInput } from "../platform/capabilities.ts";

it.effect("attempts once, retries, checks the current revision, and explicitly sets up", () => {
  const calls: Array<
    SshConnectionInput & {
      confirm?: Effect.Effect<boolean>;
      installation?: string;
      pen?: { meshId: string; nodeId: string };
    }
  > = [];
  const machine = member("c");
  const ready = {
    kind: "ready",
    seq: 1,
    meshId: mesh,
    selfNodeId: node("z"),
    members: [machine],
  } as const;
  const program = Effect.gen(function* () {
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.some(ready));
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    );
    const registry = yield* fakeRegistry(entries);
    const onboarding = ConnectionOnboarding.of({
      registerPairing: () => Effect.die("unexpected pairing"),
      updateBearer: () => Effect.die("unexpected bearer update"),
      registerSsh: (input: SshConnectionInput) => {
        calls.push(input);
        return input.keyOnly
          ? Effect.fail(
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "missing",
                existingRuntimeRequired: true,
              }),
            )
          : Effect.succeed(EnvironmentId.make("setup"));
      },
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, registry),
      Layer.succeed(ConnectionOnboarding, onboarding),
      Layer.succeed(PenMembership, { latest, admit: () => Effect.void }),
    );
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(ready);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        keyOnly: true,
        installation: "existing-only",
        label: "c",
        pen: { meshId: mesh, nodeId: machine.nodeId },
      });
      expect((yield* SubscriptionRef.get(discovery.statuses))[0]?.state).toBe("not-set-up");
      yield* discovery.pass(ready);
      expect(calls).toHaveLength(1);
      yield* discovery.retry(machine.nodeId);
      yield* discovery.pass(ready);
      expect(calls).toHaveLength(2);
      const confirm = calls[0]?.confirm;
      expect(confirm).toBeDefined();
      if (confirm === undefined) return;
      expect(yield* confirm).toBe(true);
      yield* SubscriptionRef.set(latest, Option.some({ ...ready, members: [] }));
      expect(yield* confirm).toBe(false);
      if (machine.route.kind !== "trusted") return;
      yield* SubscriptionRef.set(
        latest,
        Option.some({
          ...ready,
          members: [{ ...machine, route: { ...machine.route, revision: "2" } }],
        }),
      );
      expect(yield* confirm).toBe(false);
      yield* SubscriptionRef.set(latest, Option.some(ready));
      expect(yield* discovery.setUp(machine.nodeId)).toBe(EnvironmentId.make("setup"));
      expect(calls[2]).toMatchObject({
        keyOnly: false,
        label: "c",
        pen: { meshId: mesh, nodeId: machine.nodeId },
      });
      expect(calls[2]?.installation).toBeUndefined();
      yield* discovery.pass({ ...ready, members: [{ ...machine, online: true }] });
      expect(calls).toHaveLength(3);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(dependencies))));
  });
  return program;
});

import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { watchPenDiscovery } from "./penDiscovery.ts";

const fakeRegistry = Effect.fn(function* (
  entries: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>,
  removeRoute: (env: EnvironmentId, route: string) => Effect.Effect<void> = () => Effect.void,
) {
  const unused = () => Effect.die("unexpected registry call");
  const unusedStream = () => Stream.die("unexpected registry stream");
  return EnvironmentRegistry.of({
    entries,
    networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
    start: Effect.void,
    register: unused,
    registerPlatform: unused,
    assertKnownAddress: unused,
    reconcilePlatform: unused,
    remove: unused,
    removeRoute,
    reorderRoutes: unused,
    removeRelayEnvironments: unused,
    setPenLive: () => Effect.void,
    retryNow: unused,
    reconnect: unused,
    setEnabled: unused,
    setCompatibility: unused,
    state: unused,
    stateChanges: unusedStream,
    run: unused,
    runStream: unusedStream,
    followStream: unusedStream,
  });
});

it.effect("interrupts attempts on newer membership and never starts more than two", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const machines = [member("c"), member("d"), member("e")];
      const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.none());
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map());
      const started = yield* Queue.unbounded<string>();
      const hold = yield* Deferred.make<EnvironmentId>();
      const registry = yield* fakeRegistry(entries);
      const onboarding = ConnectionOnboarding.of({
        registerPairing: () => Effect.die("unexpected pairing"),
        updateBearer: () => Effect.die("unexpected bearer update"),
        registerSsh: (input: SshConnectionInput) =>
          Queue.offer(started, input.label ?? "").pipe(Effect.andThen(Deferred.await(hold))),
      });
      const deps = Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, registry),
        Layer.succeed(ConnectionOnboarding, onboarding),
        Layer.succeed(PenMembership, { latest, admit: () => Effect.void }),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PenDiscovery;
        yield* watchPenDiscovery.pipe(Effect.forkScoped);
        yield* SubscriptionRef.set(
          latest,
          Option.some({
            kind: "ready",
            seq: 1,
            meshId: mesh,
            selfNodeId: node("z"),
            members: machines,
          }),
        );
        expect([yield* Queue.take(started), yield* Queue.take(started)].sort()).toEqual(["c", "d"]);
        expect(Option.isNone(yield* Queue.poll(started))).toBe(true);
        yield* SubscriptionRef.set(latest, Option.some({ kind: "disabled" }));
        yield* SubscriptionRef.changes(discovery.statuses).pipe(
          Stream.filter((value) => value.length === 0),
          Stream.runHead,
        );
        expect(yield* SubscriptionRef.get(discovery.availability)).toBe("disabled");
        expect(Option.isNone(yield* Queue.poll(started))).toBe(true);
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(deps))));
    }),
  ),
);

it.effect(
  "removes stale managed routes for ready, disabled and not-member but preserves them when unavailable",
  () =>
    Effect.gen(function* () {
      const id = penRouteConnectionId(mesh, node("c"));
      const saved = entry(id, "host");
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[saved.target.environmentId, saved]]));
      const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.none());
      const removed: string[] = [];
      const registry = yield* fakeRegistry(entries, (_env: EnvironmentId, route: string) =>
        Effect.sync(() => {
          removed.push(route);
        }),
      );
      const onboarding = ConnectionOnboarding.of({
        registerPairing: () => Effect.die("unexpected pairing"),
        updateBearer: () => Effect.die("unexpected bearer update"),
        registerSsh: () => Effect.succeed(EnvironmentId.make("unused")),
      });
      const deps = Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, registry),
        Layer.succeed(ConnectionOnboarding, onboarding),
        Layer.succeed(PenMembership, { latest, admit: () => Effect.void }),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PenDiscovery;
        yield* discovery.pass({ kind: "unavailable", seq: 1, reason: "stale" });
        expect(removed).toEqual([]);
        yield* discovery.pass({
          kind: "ready",
          seq: 2,
          meshId: mesh,
          selfNodeId: node("z"),
          members: [],
        });
        yield* discovery.pass({ kind: "not-member", seq: 3 });
        yield* discovery.pass({ kind: "disabled" });
        expect(removed).toEqual([id, id, id]);
      }).pipe(Effect.provide(layer.pipe(Layer.provide(deps))));
    }),
);

const readyState = (members: ReadonlyArray<DesktopPenMember> = [member("c")]) => ({
  kind: "ready" as const,
  seq: 1,
  meshId: mesh,
  selfNodeId: node("z"),
  members,
});

const discoveryFixture = Effect.fn(function* (
  registerSsh: (typeof ConnectionOnboarding.Service)["registerSsh"],
  saved: ReadonlyArray<ConnectionCatalogEntry> = [],
) {
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(saved.map((item) => [item.target.environmentId, item])),
  );
  const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
    Option.some(readyState()),
  );
  const removed: string[] = [];
  const registry = yield* fakeRegistry(entries, (_id, route) =>
    Effect.sync(() => {
      removed.push(route);
    }),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(EnvironmentRegistry, registry),
    Layer.succeed(
      ConnectionOnboarding,
      ConnectionOnboarding.of({
        registerSsh,
        registerPairing: () => Effect.die("unexpected pairing"),
        updateBearer: () => Effect.die("unexpected bearer update"),
      }),
    ),
    Layer.succeed(PenMembership, PenMembership.of({ latest, admit: () => Effect.void })),
  );
  return {
    latest,
    entries,
    removed,
    layer: discoveryLayer.pipe(
      Layer.provideMerge(liveSetLayer.pipe(Layer.provideMerge(dependencies))),
    ),
  };
});

it.effect("does not retry an identical state after existing runtime is required", () =>
  Effect.gen(function* () {
    let calls = 0;
    const h = yield* discoveryFixture(() => {
      calls++;
      return Effect.fail(
        new ConnectionBlockedError({
          reason: "configuration",
          detail: "missing",
          existingRuntimeRequired: true,
        }),
      );
    });
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(readyState());
      yield* discovery.pass(readyState());
      expect(calls).toBe(1);
      expect((yield* SubscriptionRef.get(discovery.statuses))[0]?.state).toBe("not-set-up");
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("retry allows another attempt for the same member", () =>
  Effect.gen(function* () {
    let calls = 0;
    const h = yield* discoveryFixture(() => {
      calls++;
      return Effect.fail(
        new ConnectionBlockedError({ reason: "configuration", detail: "missing" }),
      );
    });
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(readyState());
      yield* discovery.retry(node("c"));
      yield* discovery.pass(readyState());
      expect(calls).toBe(2);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("an offline to online hint allows another attempt", () =>
  Effect.gen(function* () {
    let calls = 0;
    const h = yield* discoveryFixture(() => {
      calls++;
      return Effect.fail(
        new ConnectionBlockedError({ reason: "configuration", detail: "missing" }),
      );
    });
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(readyState([{ ...member("c"), online: false }]));
      expect(calls).toBe(0);
      expect((yield* SubscriptionRef.get(discovery.statuses))[0]?.state).toBe("pen-offline");
      yield* discovery.pass(readyState([{ ...member("c"), online: true }]));
      expect(calls).toBe(1);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("unavailable leaves managed routes and statuses unchanged", () =>
  Effect.gen(function* () {
    const id = penRouteConnectionId(mesh, node("d"));
    const h = yield* discoveryFixture(() =>
      Effect.fail(new ConnectionBlockedError({ reason: "configuration", detail: "missing" })),
    );
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(readyState());
      const statuses = yield* SubscriptionRef.get(discovery.statuses);
      const saved = entry(id, "host");
      yield* SubscriptionRef.set(h.entries, new Map([[saved.target.environmentId, saved]]));
      yield* discovery.pass({ kind: "unavailable", seq: 2, reason: "stale" });
      expect(h.removed).toEqual([]);
      expect(yield* SubscriptionRef.get(h.entries)).toEqual(
        new Map([[saved.target.environmentId, saved]]),
      );
      expect(yield* SubscriptionRef.get(discovery.statuses)).toEqual(statuses);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each([
  [
    new ConnectionBlockedError({
      reason: "configuration",
      detail: "missing",
      existingRuntimeRequired: true,
    }),
    "not-set-up",
  ],
  [
    new ConnectionBlockedError({
      reason: "configuration",
      detail: "old",
      serverUpdateRequired: true,
    }),
    "needs-update",
  ],
  [new ConnectionBlockedError({ reason: "authentication", detail: "key" }), "key-rejected"],
  [new ConnectionTransientError({ reason: "host-unreachable", detail: "offline" }), "offline"],
  [new ConnectionBlockedError({ reason: "configuration", detail: "other" }), "failed"],
] as const)("maps an attempt failure to %s", ([error, expected]) =>
  Effect.gen(function* () {
    const h = yield* discoveryFixture(() => Effect.fail(error));
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(readyState());
      expect((yield* SubscriptionRef.get(discovery.statuses))[0]?.state).toBe(expected);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each([{ kind: "disabled" }, { kind: "not-member", seq: 2 }] as const)(
  "clears routes, statuses and attempts on %s",
  (state) =>
    Effect.gen(function* () {
      let calls = 0;
      const ids = [
        penRouteConnectionId(mesh, node("d")),
        penRouteConnectionId(otherMesh, node("e")),
      ];
      const h = yield* discoveryFixture(
        () =>
          Effect.sync(() => {
            calls++;
            return EnvironmentId.make("result");
          }),
        ids.map((id) => entry(id, id)),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PenDiscovery;
        yield* discovery.pass(readyState());
        yield* SubscriptionRef.set(
          h.entries,
          new Map(
            ids.map((id) => {
              const saved = entry(id, id);
              return [saved.target.environmentId, saved];
            }),
          ),
        );
        yield* discovery.pass(state);
        expect(h.removed.slice(-2)).toEqual(ids);
        expect(yield* SubscriptionRef.get(discovery.statuses)).toEqual([]);
        yield* SubscriptionRef.set(h.entries, new Map());
        yield* discovery.pass(readyState());
        expect(calls).toBe(2);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect("an ordinary SSH alias is yours and is never attempted", () =>
  Effect.gen(function* () {
    let calls = 0;
    const h = yield* discoveryFixture(
      () =>
        Effect.sync(() => {
          calls++;
          return EnvironmentId.make("result");
        }),
      [entry("own", `pen-${node("c")}`)],
    );
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(readyState());
      expect((yield* SubscriptionRef.get(discovery.statuses))[0]?.state).toBe("yours");
      expect(calls).toBe(0);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("confirm refuses a changed Noise key", () =>
  Effect.gen(function* () {
    const calls: SshConnectionInput[] = [];
    const h = yield* discoveryFixture((input) =>
      Effect.sync(() => {
        calls.push(input);
        return EnvironmentId.make("result");
      }),
    );
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      yield* discovery.pass(readyState());
      const confirm = calls[0]?.confirm;
      expect(confirm).toBeDefined();
      if (!confirm) return;
      yield* SubscriptionRef.set(
        h.latest,
        Option.some(readyState([{ ...member("c"), noisePub: "changed" }])),
      );
      expect(yield* confirm).toBe(false);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect.each(["removed", "revision"] as const)(
  "confirm refuses a member after its %s changes",
  (change) =>
    Effect.gen(function* () {
      const calls: SshConnectionInput[] = [];
      const machine = member("c");
      const h = yield* discoveryFixture((input) =>
        Effect.sync(() => {
          calls.push(input);
          return EnvironmentId.make("result");
        }),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PenDiscovery;
        yield* discovery.pass(readyState());
        const confirm = calls[0]?.confirm;
        expect(confirm).toBeDefined();
        if (!confirm || machine.route.kind !== "trusted") return;
        expect(yield* confirm).toBe(true);
        const members =
          change === "removed" ? [] : [{ ...machine, route: { ...machine.route, revision: "2" } }];
        yield* SubscriptionRef.set(h.latest, Option.some(readyState(members)));
        expect(yield* confirm).toBe(false);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect("setUp registers without an installation policy and with keyOnly false", () =>
  Effect.gen(function* () {
    const calls: SshConnectionInput[] = [];
    const h = yield* discoveryFixture((input) =>
      Effect.sync(() => {
        calls.push(input);
        return EnvironmentId.make("setup");
      }),
    );
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      expect(yield* discovery.setUp(node("c"))).toBe(EnvironmentId.make("setup"));
      expect(calls[0]).toMatchObject({ keyOnly: false, pen: { meshId: mesh, nodeId: node("c") } });
      expect(calls[0]?.installation).toBeUndefined();
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("starts the third candidate only after one of two active attempts finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const first = yield* Deferred.make<EnvironmentId>();
      const second = yield* Deferred.make<EnvironmentId>();
      const h = yield* discoveryFixture((input) =>
        Queue.offer(started, input.label ?? "").pipe(
          Effect.andThen(Deferred.await(input.label === "c" ? first : second)),
        ),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PenDiscovery;
        const work = yield* discovery
          .pass(readyState([member("c"), member("d"), member("e")]))
          .pipe(Effect.forkScoped);
        expect([yield* Queue.take(started), yield* Queue.take(started)].sort()).toEqual(["c", "d"]);
        expect(Option.isNone(yield* Queue.poll(started))).toBe(true);
        yield* Deferred.succeed(first, EnvironmentId.make("first"));
        expect(yield* Queue.take(started)).toBe("e");
        yield* Deferred.succeed(second, EnvironmentId.make("second"));
        yield* Fiber.join(work);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("retries an interrupted attempt in the newer membership state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const hold = yield* Deferred.make<EnvironmentId>();
      const h = yield* discoveryFixture((input) =>
        Queue.offer(started, input.label ?? "").pipe(Effect.andThen(Deferred.await(hold))),
      );
      yield* SubscriptionRef.set(h.latest, Option.none());
      yield* Effect.gen(function* () {
        yield* watchPenDiscovery.pipe(Effect.forkScoped);
        yield* SubscriptionRef.set(h.latest, Option.some(readyState()));
        expect(yield* Queue.take(started)).toBe("c");
        yield* SubscriptionRef.set(h.latest, Option.some({ ...readyState(), seq: 2 }));
        expect(yield* Queue.take(started)).toBe("c");
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect.each(["connect", "setUp"] as const)(
  "%s takes a slot for an online candidate when the live set is full",
  (action) =>
    Effect.gen(function* () {
      const machines = Array.from({ length: 17 }, (_, i) => member(String.fromCharCode(98 + i)));
      const state = readyState(machines);
      const saved = machines
        .slice(0, 16)
        .map((machine) => entry(penRouteConnectionId(mesh, machine.nodeId), machine.name));
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map(saved.map((item) => [item.target.environmentId, item])));
      const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
        Option.some(state),
      );
      const baseRegistry = yield* fakeRegistry(entries);
      const liveIds = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
      const registry = EnvironmentRegistry.of({
        ...baseRegistry,
        setPenLive: (ids) => Ref.set(liveIds, ids),
        state: (environmentId) => Effect.fail(new EnvironmentNotRegisteredError({ environmentId })),
      });
      const calls: SshConnectionInput[] = [];
      const onboarding = ConnectionOnboarding.of({
        registerPairing: () => Effect.die("unexpected pairing"),
        updateBearer: () => Effect.die("unexpected bearer update"),
        registerSsh: (input) =>
          Effect.gen(function* () {
            calls.push(input);
            const added = entry(
              penRouteConnectionId(mesh, machines[16]!.nodeId),
              machines[16]!.name,
            );
            yield* SubscriptionRef.update(
              entries,
              (current) => new Map([...current, [added.target.environmentId, added]]),
            );
            return added.target.environmentId;
          }),
      });
      const deps = Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, registry),
        Layer.succeed(ConnectionOnboarding, onboarding),
        Layer.succeed(PenMembership, PenMembership.of({ latest, admit: () => Effect.void })),
      );
      const live = liveSetLayer.pipe(Layer.provideMerge(deps));
      const combined = discoveryLayer.pipe(Layer.provideMerge(live));
      yield* Effect.gen(function* () {
        const service = yield* PenDiscovery;
        const liveSet = yield* PenLiveSet;
        yield* liveSet.recompute;
        yield* service.pass(state);
        expect(calls).toHaveLength(0);
        expect(
          (yield* SubscriptionRef.get(service.statuses)).find(
            (row) => row.nodeId === machines[16]!.nodeId,
          )?.state,
        ).toBe("waiting");
        if (action === "connect") {
          yield* service.connect(machines[16]!.nodeId);
          yield* service.pass(state);
        } else {
          yield* service.setUp(machines[16]!.nodeId);
        }
        expect(calls).toHaveLength(1);
        expect(calls[0]?.keyOnly).toBe(action === "connect");
        expect(
          (yield* Ref.get(liveIds)).has(
            EnvironmentId.make(penRouteConnectionId(mesh, machines[16]!.nodeId)),
          ),
        ).toBe(true);
        expect(
          (yield* SubscriptionRef.get(liveSet.held)).has(
            EnvironmentId.make(penRouteConnectionId(mesh, machines[16]!.nodeId)),
          ),
        ).toBe(false);
        expect([...(yield* SubscriptionRef.get(liveSet.held)).values()]).toContain("waiting");
      }).pipe(Effect.provide(combined));
    }),
);

it.effect("failed onboarding releases its reservation", () =>
  Effect.gen(function* () {
    const h = yield* discoveryFixture(() =>
      Effect.fail(new ConnectionBlockedError({ reason: "configuration", detail: "failed" })),
    );
    yield* Effect.gen(function* () {
      const discovery = yield* PenDiscovery;
      const live = yield* PenLiveSet;
      yield* discovery.pass(readyState());
      expect(yield* live.admitOnboarding(node("c"))).toBe(true);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("interrupted onboarding releases its reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const h = yield* discoveryFixture(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PenDiscovery;
        const live = yield* PenLiveSet;
        const fiber = yield* discovery.pass(readyState()).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(yield* live.admitOnboarding(node("c"))).toBe(true);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("duplicate setup cannot release the first setup reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const h = yield* discoveryFixture(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* PenDiscovery;
        const live = yield* PenLiveSet;
        const first = yield* discovery.setUp(node("c")).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const second = yield* Effect.result(discovery.setUp(node("c")));
        expect(second._tag).toBe("Failure");
        expect(yield* live.admitOnboarding(node("c"))).toBe(false);
        yield* Fiber.interrupt(first);
        expect(yield* live.admitOnboarding(node("c"))).toBe(true);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);
