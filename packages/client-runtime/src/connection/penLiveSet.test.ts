import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { SshConnectionTarget } from "./model.ts";
import { penRouteConnectionId } from "./routes.ts";
import { decide } from "./penLiveSet.ts";

const meshId = "a".repeat(26);
const node = (n: number) => String.fromCharCode(97 + n).repeat(26);
const entries = Array.from({ length: 17 }, (_, n) => ({
  enabled: true,
  target: new SshConnectionTarget({
    environmentId: EnvironmentId.make(`env-${n}`),
    connectionId: penRouteConnectionId(meshId, node(n)),
    label: `env-${n}`,
  }),
  profile: Option.none(),
}));
const membership = {
  kind: "ready" as const,
  seq: 1,
  meshId,
  selfNodeId: node(99),
  members: entries.map((_, n) => ({
    nodeId: node(n),
    name: `${n}`,
    noisePub: `${n}`,
    online: true,
    route: {
      kind: "trusted" as const,
      target: { alias: `${n}`, hostname: `${n}`, username: null, port: null },
      revision: "1",
    },
  })),
};

describe("Pen live selection", () => {
  it("holds the seventeenth online environment and opens a recent choice first", () => {
    const initial = decide({ entries, membership, recency: [], onboarding: new Set(), limit: 16 });
    expect(initial.live.size).toBe(16);
    expect(initial.waiting.has(EnvironmentId.make("env-16"))).toBe(true);
    const next = decide({
      entries,
      membership,
      recency: [EnvironmentId.make("env-16")],
      onboarding: new Set(),
      limit: 16,
    });
    expect(next.live.has(EnvironmentId.make("env-16"))).toBe(true);
    expect(next.waiting.has(EnvironmentId.make("env-15"))).toBe(true);
  });
  it("holds offline entries without consuming a slot", () => {
    const result = decide({
      entries,
      membership: {
        ...membership,
        members: membership.members.map((member, n) =>
          n === 0 ? { ...member, online: false } : member,
        ),
      },
      recency: [],
      onboarding: new Set(),
      limit: 16,
    });
    expect(result.offline.has(EnvironmentId.make("env-0"))).toBe(true);
    expect(result.live.has(EnvironmentId.make("env-16"))).toBe(true);
  });
});

it("reserves capacity for onboarding and never holds an entry with a non-Pen route", () => {
  const mixed = {
    ...entries[0]!,
    alternateRoutes: [
      {
        target: new SshConnectionTarget({
          environmentId: entries[0]!.target.environmentId,
          connectionId: "ssh:ordinary",
          label: "ordinary",
        }),
        profile: Option.none(),
      },
    ],
  };
  const result = decide({
    entries: [mixed, ...entries.slice(1)],
    membership,
    recency: [],
    onboarding: new Set([node(20)]),
    limit: 16,
  });
  expect(result.live.size).toBe(15);
  expect(result.live.has(mixed.target.environmentId)).toBe(false);
  expect(result.offline.has(mixed.target.environmentId)).toBe(false);
  expect(result.waiting.has(mixed.target.environmentId)).toBe(false);
  expect(result.waiting.has(EnvironmentId.make("env-16"))).toBe(true);
});

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { SshConnectionProfile } from "./catalog.ts";
import { PenMembership } from "./penMembership.ts";
import { layer as liveLayer, PenLiveSet } from "./penLiveSet.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { awaitConnectionState, makeHarness, SSH_TARGET } from "./registry.testkit.ts";
import type { PenMembersInput } from "../platform/capabilities.ts";

const liveFixture = Effect.fn(function* (count: number, disabled: number[] = []) {
  const targets = entries.slice(0, count).map((entry) => entry.target);
  const profiles = targets.map(
    (target) =>
      new SshConnectionProfile({
        environmentId: target.environmentId,
        connectionId: target.connectionId,
        label: target.label,
        target: SSH_TARGET,
      }),
  );
  const h = yield* makeHarness(targets, profiles, [], {
    initialDisabled: disabled.map((n) => entries[n]!.target.environmentId),
  });
  const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
    Option.some(membership),
  );
  const deps = Layer.mergeAll(
    h.layer,
    Layer.succeed(PenMembership, PenMembership.of({ latest, admit: () => Effect.void })),
  );
  return { ...h, latest, combined: liveLayer.pipe(Layer.provideMerge(deps)) };
});

it.effect(
  "unavailable preserves live connections and offline members tear down and reconnect without changing enabled",
  () =>
    Effect.gen(function* () {
      const h = yield* liveFixture(2);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry;
        const live = yield* PenLiveSet;
        const id = entries[0]!.target.environmentId;
        yield* registry.start;
        yield* live.recompute;
        yield* awaitConnectionState(registry, id, (state) => state.phase === "connected");
        const held = yield* SubscriptionRef.get(live.held);
        yield* SubscriptionRef.set(
          h.latest,
          Option.some({ kind: "unavailable", seq: 2, reason: "stale" }),
        );
        yield* live.recompute;
        expect((yield* registry.state(id)).phase).toBe("connected");
        expect(yield* SubscriptionRef.get(live.held)).toEqual(held);
        yield* SubscriptionRef.set(
          h.latest,
          Option.some({
            ...membership,
            members: membership.members.map((m, i) => (i === 0 ? { ...m, online: false } : m)),
          }),
        );
        yield* live.recompute;
        yield* awaitConnectionState(registry, id, (state) => !state.desired);
        expect((yield* SubscriptionRef.get(live.held)).get(id)).toBe("offline");
        expect(yield* Ref.get(h.disconnectedSshTargets)).toContainEqual(SSH_TARGET);
        yield* SubscriptionRef.set(h.latest, Option.some(membership));
        yield* live.recompute;
        yield* awaitConnectionState(registry, id, (state) => state.phase === "connected");
        expect(
          (yield* Ref.get(h.connectedRoutes)).filter(
            (route) => route === entries[0]!.target.connectionId,
          ),
        ).toHaveLength(2);
        expect(yield* Ref.get(h.storedDisabled)).toEqual(new Set());
      }).pipe(Effect.provide(h.combined));
    }),
);

it.effect(
  "opening the seventeenth holds the least recent entry and disabled entries stay off",
  () =>
    Effect.gen(function* () {
      const h = yield* liveFixture(17);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry;
        const live = yield* PenLiveSet;
        const first = entries[0]!.target.environmentId;
        const last = entries[16]!.target.environmentId;
        yield* registry.start;
        yield* live.recompute;
        expect((yield* SubscriptionRef.get(live.held)).get(last)).toBe("waiting");
        yield* live.open(last);
        expect((yield* SubscriptionRef.get(live.held)).get(entries[15]!.target.environmentId)).toBe(
          "waiting",
        );
        yield* awaitConnectionState(registry, last, (state) => state.phase === "connected");
        yield* registry.setEnabled(first, false);
        yield* live.recompute;
        yield* awaitConnectionState(registry, first, (state) => !state.desired);
      }).pipe(Effect.provide(h.combined));
    }),
);

it.effect(
  "onboarding reserves the last slot atomically, rejects duplicates, releases and forces a slot",
  () =>
    Effect.gen(function* () {
      const h = yield* liveFixture(15);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry;
        const live = yield* PenLiveSet;
        yield* registry.start;
        yield* live.recompute;
        const results = yield* Effect.all(
          [live.admitOnboarding("candidate-a"), live.admitOnboarding("candidate-b")],
          { concurrency: "unbounded" },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results[0] ? "candidate-a" : "candidate-b";
        expect(yield* live.admitOnboarding(winner)).toBe(false);
        yield* live.releaseOnboarding(winner);
        expect(yield* live.admitOnboarding("candidate-c")).toBe(true);
        expect(yield* live.admitOnboarding("candidate-d", { force: true })).toBe(true);
        expect((yield* SubscriptionRef.get(live.held)).get(entries[14]!.target.environmentId)).toBe(
          "waiting",
        );
      }).pipe(Effect.provide(h.combined));
    }),
);
