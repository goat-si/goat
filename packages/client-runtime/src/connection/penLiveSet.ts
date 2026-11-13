import type { DesktopPenMembersState, EnvironmentId } from "@goat/contracts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { isPenOnlyEntry } from "./penGate.ts";
import type { PenHold } from "./presentation.ts";
import { connectionRoutes, penRouteOwner } from "./routes.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { PenMembership } from "./penMembership.ts";
import { EnvironmentRegistry } from "./registry.ts";

const PEN_LIVE_LIMIT = 16;

export function decide(input: {
  readonly entries: ReadonlyArray<ConnectionCatalogEntry>;
  readonly membership: Extract<DesktopPenMembersState, { kind: "ready" }>;
  readonly recency: ReadonlyArray<EnvironmentId>;
  readonly onboarding: ReadonlySet<string>;
  readonly limit: number;
}) {
  const { membership } = input;
  const memberOrder = new Map(membership.members.map((member, i) => [member.nodeId, i]));
  const recentOrder = new Map(input.recency.map((id, i) => [id, i]));
  const offline = new Set<EnvironmentId>();
  const waiting = new Set<EnvironmentId>();
  const live = new Set<EnvironmentId>();
  const known = new Set<string>();
  const online = input.entries.flatMap((entry) => {
    if (!isPenOnlyEntry(entry)) return [];
    const owners = connectionRoutes(entry).flatMap((route) =>
      route.target._tag === "SshConnectionTarget" ? [penRouteOwner(route.target.connectionId)] : [],
    );
    const member = membership.members.find((item) =>
      owners.some((owner) => owner?.meshId === membership.meshId && owner.nodeId === item.nodeId),
    );
    if (member !== undefined) known.add(member.nodeId);
    // Only Pen's presence holds a machine: an alias GOAT could not read just now is not offline.
    if (!member?.online) {
      offline.add(entry.target.environmentId);
      return [];
    }
    return entry.enabled ? [{ id: entry.target.environmentId, nodeId: member.nodeId }] : [];
  });
  online.sort(
    (a, b) =>
      (recentOrder.get(a.id) ?? Infinity) - (recentOrder.get(b.id) ?? Infinity) ||
      (memberOrder.get(a.nodeId) ?? Infinity) - (memberOrder.get(b.nodeId) ?? Infinity),
  );
  // A reservation whose environment already exists is that entry, not a second slot.
  const pending = [...input.onboarding].filter((nodeId) => !known.has(nodeId)).length;
  const capacity = Math.max(0, input.limit - pending);
  for (const [index, item] of online.entries()) (index < capacity ? live : waiting).add(item.id);
  return { live, offline, waiting };
}

type Hold = PenHold;
export class PenLiveSet extends Context.Service<
  PenLiveSet,
  {
    readonly held: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, Hold>>;
    readonly open: (id: EnvironmentId) => Effect.Effect<void>;
    readonly admitOnboarding: (
      nodeId: string,
      options?: { force?: boolean },
    ) => Effect.Effect<boolean>;
    readonly releaseOnboarding: (nodeId: string) => Effect.Effect<void>;
    readonly recompute: Effect.Effect<void>;
  }
>()("@goat/client-runtime/connection/penLiveSet") {}

const make = Effect.gen(function* () {
  const membership = yield* PenMembership;
  const registry = yield* EnvironmentRegistry;
  const held = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, Hold>>(new Map());
  const state = yield* Ref.make<{
    recency: ReadonlyArray<EnvironmentId>;
    onboarding: ReadonlySet<string>;
    live: ReadonlySet<EnvironmentId>;
  }>({ recency: [], onboarding: new Set(), live: new Set() });
  // One pass at a time: two interleaved passes could hand the registry an older set last.
  const turn = yield* Semaphore.make(1);
  const pass = Effect.gen(function* () {
    const latest = yield* SubscriptionRef.get(membership.latest);
    const entries = yield* SubscriptionRef.get(registry.entries);
    if (Option.isNone(latest) || latest.value.kind !== "ready") {
      // Without a list nothing is opened or closed; a held machine keeps its reason or gets this one.
      const { live } = yield* Ref.get(state);
      yield* SubscriptionRef.update(
        held,
        (current) =>
          new Map(
            [...entries.values()]
              .filter((entry) => isPenOnlyEntry(entry) && !live.has(entry.target.environmentId))
              .map((entry) => {
                const id = entry.target.environmentId;
                return [id, current.get(id) ?? "no-list"] as const;
              }),
          ),
      );
      return;
    }
    const next = yield* Ref.modify(state, (current) => {
      const result = decide({
        entries: [...entries.values()],
        membership: latest.value as Extract<DesktopPenMembersState, { kind: "ready" }>,
        recency: current.recency,
        onboarding: current.onboarding,
        limit: PEN_LIVE_LIMIT,
      });
      return [result, { ...current, live: result.live }] as const;
    });
    yield* registry.setPenLive(next.live);
    yield* SubscriptionRef.set(
      held,
      new Map([
        ...Array.from(next.offline, (id) => [id, "offline"] as const),
        ...Array.from(next.waiting, (id) => [id, "waiting"] as const),
      ]),
    );
  });
  const recompute = turn.withPermits(1)(pass);
  const open = Effect.fn("PenLiveSet.open")(function* (id: EnvironmentId) {
    yield* Ref.update(state, (current) => ({
      ...current,
      recency: [id, ...current.recency.filter((item) => item !== id)],
    }));
    yield* recompute;
  });
  const admitOnboarding = (nodeId: string, options?: { force?: boolean }) =>
    Ref.modify(state, (current) => {
      if (
        current.onboarding.has(nodeId) ||
        (!options?.force && current.live.size + current.onboarding.size >= PEN_LIVE_LIMIT)
      )
        return [false, current] as const;
      return [true, { ...current, onboarding: new Set([...current.onboarding, nodeId]) }] as const;
    }).pipe(
      // A forced slot is taken from the machine opened longest ago.
      Effect.tap((admitted) => (admitted && options?.force ? recompute : Effect.void)),
    );
  const releaseOnboarding = (nodeId: string) =>
    Ref.update(state, (current) => {
      const onboarding = new Set(current.onboarding);
      onboarding.delete(nodeId);
      return { ...current, onboarding };
    }).pipe(Effect.andThen(recompute));
  return { held, open, admitOnboarding, releaseOnboarding, recompute };
});
export const layer = Layer.effect(PenLiveSet, make);
export const watchPenLiveSet = Effect.gen(function* () {
  const membership = yield* PenMembership;
  const registry = yield* EnvironmentRegistry;
  const liveSet = yield* PenLiveSet;
  yield* Stream.merge(
    SubscriptionRef.changes(membership.latest),
    SubscriptionRef.changes(registry.entries),
  ).pipe(Stream.runForEach(() => liveSet.recompute));
});
