import type { DesktopPenMember, EnvironmentId, PenRouteRefusal } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { PenMembersInput } from "../platform/capabilities.ts";
import type * as Persistence from "../platform/persistence.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import { ConnectionOnboarding } from "./onboarding.ts";
import { PenMembership, trustedPenMember } from "./penMembership.ts";
import { PenLiveSet } from "./penLiveSet.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { connectionRoutes, penRouteOwner, sshTargetKey } from "./routes.ts";

export type PenMemberState =
  | "connected"
  | "yours"
  | "connecting"
  | "offline"
  | "pen-offline"
  | "pen-down"
  | "waiting"
  | "not-set-up"
  | "needs-update"
  | "key-rejected"
  | "refused"
  | "failed";
export interface PenMemberStatus {
  readonly nodeId: string;
  readonly name: string;
  readonly state: PenMemberState;
  readonly environmentId?: EnvironmentId;
  readonly refusal?: PenRouteRefusal;
  readonly detail?: string;
}

export function reconcilePenRoutes(input: {
  readonly meshId: string;
  readonly members: ReadonlyArray<DesktopPenMember>;
  readonly existing: ReadonlyArray<ConnectionCatalogEntry>;
}) {
  const trusted = input.members.filter((member) => member.route.kind === "trusted");
  // Not readable just now: neither proof of trust nor of a departure, so its route stays.
  const unread = new Set(
    input.members.flatMap((member) =>
      member.route.kind === "refused" && member.route.reason === "unreadable"
        ? [member.nodeId]
        : [],
    ),
  );
  const remove: Array<{ environmentId: EnvironmentId; routeId: string }> = [];
  const managed = new Map<string, EnvironmentId>();
  const yours = new Map<string, EnvironmentId>();
  for (const entry of input.existing)
    for (const route of connectionRoutes(entry)) {
      if (route.target._tag !== "SshConnectionTarget") continue;
      const owner = penRouteOwner(route.target.connectionId);
      if (owner !== null) {
        if (
          owner.meshId !== input.meshId ||
          (!trusted.some((member) => member.nodeId === owner.nodeId) && !unread.has(owner.nodeId))
        ) {
          remove.push({
            environmentId: entry.target.environmentId,
            routeId: route.target.connectionId,
          });
        } else managed.set(owner.nodeId, entry.target.environmentId);
      } else {
        const profile = Option.getOrUndefined(route.profile);
        if (profile?._tag !== "SshConnectionProfile") continue;
        for (const member of trusted)
          if (member.route.kind === "trusted" && member.route.target.alias === profile.target.alias)
            yours.set(member.nodeId, entry.target.environmentId);
      }
    }
  return {
    remove,
    managed,
    yours,
    candidates: trusted.filter(
      (member) => !managed.has(member.nodeId) && !yours.has(member.nodeId),
    ),
  };
}

export class PenDiscovery extends Context.Service<
  PenDiscovery,
  {
    readonly statuses: SubscriptionRef.SubscriptionRef<ReadonlyArray<PenMemberStatus>>;
    readonly availability: SubscriptionRef.SubscriptionRef<"pending" | PenMembersInput["kind"]>;
    readonly connect: (nodeId: string) => Effect.Effect<void>;
    readonly retry: (nodeId: string) => Effect.Effect<void>;
    readonly setUp: (
      nodeId: string,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly pass: (state: PenMembersInput) => Effect.Effect<void>;
  }
>()("@goat/client-runtime/connection/penDiscovery") {}

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const onboarding = yield* ConnectionOnboarding;
  const membership = yield* PenMembership;
  const liveSet = yield* PenLiveSet;
  const statuses = yield* SubscriptionRef.make<ReadonlyArray<PenMemberStatus>>([]);
  const availability = yield* SubscriptionRef.make<"pending" | PenMembersInput["kind"]>("pending");
  const attempts = new Map<
    string,
    { nodeId: string; noise: string; online: boolean; status?: PenMemberStatus }
  >();
  const attemptKey = (member: DesktopPenMember) => JSON.stringify([member.nodeId, member.noisePub]);
  const rerun = SubscriptionRef.update(membership.latest, (state) => state);
  const confirm = Effect.fn("PenDiscovery.confirm")(function* (
    meshId: string,
    member: DesktopPenMember,
  ) {
    const latest = yield* SubscriptionRef.get(membership.latest);
    if (Option.isNone(latest) || member.route.kind !== "trusted") return false;
    const current = trustedPenMember(latest.value, { meshId, nodeId: member.nodeId });
    return (
      current?.route.kind === "trusted" &&
      current.noisePub === member.noisePub &&
      current.route.revision === member.route.revision &&
      sshTargetKey(current.route.target) === sshTargetKey(member.route.target)
    );
  });
  const retry = Effect.fn("PenDiscovery.retry")(function* (nodeId: string) {
    for (const [key, attempt] of attempts) {
      if (attempt.nodeId === nodeId) attempts.delete(key);
    }
    yield* rerun;
  });
  const setUp = Effect.fn("PenDiscovery.setUp")(function* (nodeId: string) {
    const latest = yield* SubscriptionRef.get(membership.latest);
    const state = Option.getOrUndefined(latest);
    const member =
      state?.kind === "ready"
        ? trustedPenMember(state, { meshId: state.meshId, nodeId })
        : undefined;
    if (state?.kind !== "ready" || member?.route.kind !== "trusted")
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "This Pen member is not trusted.",
      });
    const sshTarget = member.route.target;
    const id = yield* Effect.acquireUseRelease(
      liveSet.admitOnboarding(nodeId, { force: true }),
      (admitted) =>
        admitted
          ? onboarding
              .registerSsh({
                target: sshTarget,
                label: member.name,
                keyOnly: false,
                pen: { meshId: state.meshId, nodeId },
                confirm: confirm(state.meshId, member),
              })
              .pipe(Effect.tap((environmentId) => liveSet.open(environmentId)))
          : Effect.fail(
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "This Pen member is already being set up.",
              }),
            ),
      (admitted) => (admitted ? liveSet.releaseOnboarding(nodeId) : Effect.void),
    );
    yield* rerun;
    return id;
  });
  const forced = new Set<string>();
  const connect = Effect.fn("PenDiscovery.connect")(function* (nodeId: string) {
    const row = (yield* SubscriptionRef.get(statuses)).find((item) => item.nodeId === nodeId);
    if (row?.environmentId !== undefined) return yield* liveSet.open(row.environmentId);
    if (row?.state !== "waiting") return;
    // The next pass takes a slot for it from the machine opened longest ago.
    forced.add(nodeId);
    yield* retry(nodeId);
  });
  const pass = Effect.fn("PenDiscovery.pass")(function* (state: PenMembersInput) {
    yield* SubscriptionRef.set(availability, state.kind);
    if (state.kind === "unavailable") return;
    const entries = yield* SubscriptionRef.get(registry.entries);
    const result = reconcilePenRoutes({
      meshId: state.kind === "ready" ? state.meshId : "",
      members: state.kind === "ready" ? state.members : [],
      existing: [...entries.values()],
    });
    for (const item of result.remove)
      yield* registry
        .removeRoute(item.environmentId, item.routeId)
        .pipe(Effect.catch((error) => Effect.logWarning("Could not remove Pen route", { error })));
    if (state.kind !== "ready") {
      attempts.clear();
      yield* SubscriptionRef.set(statuses, []);
      return;
    }
    const rows: PenMemberStatus[] = [];
    for (const member of state.members) {
      const environmentId = result.managed.get(member.nodeId);
      const own = result.yours.get(member.nodeId);
      if (member.route.kind === "refused")
        rows.push({
          nodeId: member.nodeId,
          name: member.name,
          state: "refused",
          refusal: member.route.reason,
        });
      else if (environmentId !== undefined) {
        const connected = yield* registry.state(environmentId).pipe(
          Effect.map((value) => value.phase === "connected"),
          Effect.orElseSucceed(() => false),
        );
        rows.push({
          nodeId: member.nodeId,
          name: member.name,
          environmentId,
          state: connected ? "connected" : "connecting",
        });
      } else if (own !== undefined)
        rows.push({ nodeId: member.nodeId, name: member.name, environmentId: own, state: "yours" });
      else
        rows.push(
          attempts.get(attemptKey(member))?.status ?? {
            nodeId: member.nodeId,
            name: member.name,
            state: "connecting",
          },
        );
    }
    yield* SubscriptionRef.set(statuses, rows);
    const candidates = [...result.candidates].sort((a, b) => Number(b.online) - Number(a.online));
    yield* Effect.forEach(
      candidates,
      (member) =>
        Effect.gen(function* () {
          if (member.route.kind !== "trusted") return;
          if (!member.online) {
            attempts.delete(attemptKey(member));
            yield* SubscriptionRef.update(statuses, (current) =>
              current.map((row) =>
                row.nodeId === member.nodeId
                  ? { nodeId: member.nodeId, name: member.name, state: "pen-offline" }
                  : row,
              ),
            );
            return;
          }
          const key = attemptKey(member);
          const previous = attempts.get(key);
          if (previous?.noise === member.noisePub && !(member.online && !previous.online)) {
            if (!member.online && previous.online)
              attempts.set(key, { ...previous, online: false });
            return;
          }
          const wasForced = forced.delete(member.nodeId);
          const sshTarget = member.route.target;
          const attempt = yield* Effect.acquireUseRelease(
            liveSet.admitOnboarding(member.nodeId, { force: wasForced }),
            (admitted) =>
              admitted
                ? Effect.gen(function* () {
                    attempts.set(key, {
                      nodeId: member.nodeId,
                      noise: member.noisePub,
                      online: member.online,
                    });
                    yield* SubscriptionRef.update(statuses, (current) =>
                      current.map((row) =>
                        row.nodeId === member.nodeId
                          ? { nodeId: member.nodeId, name: member.name, state: "connecting" }
                          : row,
                      ),
                    );
                    const result = yield* Effect.result(
                      onboarding.registerSsh({
                        target: sshTarget,
                        keyOnly: true,
                        installation: "existing-only",
                        label: member.name,
                        pen: { meshId: state.meshId, nodeId: member.nodeId },
                        confirm: confirm(state.meshId, member),
                      }),
                    );
                    if (wasForced && result._tag === "Success") yield* liveSet.open(result.success);
                    return Option.some(result);
                  })
                : Effect.succeed(Option.none<never>()),
            (admitted) => (admitted ? liveSet.releaseOnboarding(member.nodeId) : Effect.void),
          );
          if (Option.isNone(attempt)) {
            yield* SubscriptionRef.update(statuses, (current) =>
              current.map((row) =>
                row.nodeId === member.nodeId
                  ? { nodeId: member.nodeId, name: member.name, state: "waiting" }
                  : row,
              ),
            );
            return;
          }
          const outcome = attempt.value;
          let status: PenMemberStatus;
          if (outcome._tag === "Success")
            status = {
              nodeId: member.nodeId,
              name: member.name,
              state: "connecting",
              environmentId: outcome.success,
            };
          else {
            const error = outcome.failure;
            if (error._tag === "ConnectionAttemptSuperseded") return;
            const mapped: PenMemberState =
              error._tag === "ConnectionBlockedError" && error.existingRuntimeRequired
                ? "not-set-up"
                : error._tag === "ConnectionBlockedError" && error.serverUpdateRequired
                  ? "needs-update"
                  : error._tag === "ConnectionBlockedError" && error.reason === "authentication"
                    ? "key-rejected"
                    : error._tag === "ConnectionTransientError" &&
                        error.reason === "host-unreachable"
                      ? "offline"
                      : "failed";
            status = {
              nodeId: member.nodeId,
              name: member.name,
              state: mapped,
              detail: error._tag === "ConnectionPersistenceError" ? error.message : error.detail,
            };
          }
          attempts.set(key, {
            nodeId: member.nodeId,
            noise: member.noisePub,
            online: member.online,
            status,
          });
          yield* SubscriptionRef.update(statuses, (current) =>
            current.map((row) => (row.nodeId === member.nodeId ? status : row)),
          );
          // A pass cut short by a newer state never ran this attempt to its end.
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => attempts.delete(attemptKey(member))))),
      { concurrency: 2, discard: true },
    );
    // A Connect whose machine was not a candidate on this pass does not wait for a later one.
    forced.clear();
  });
  return { statuses, availability, retry, connect, setUp, pass };
});
export const layer = Layer.effect(PenDiscovery, make);
export const watchPenDiscovery = Effect.gen(function* () {
  const membership = yield* PenMembership;
  const discovery = yield* PenDiscovery;
  yield* SubscriptionRef.changes(membership.latest).pipe(
    Stream.filter(Option.isSome),
    Stream.switchMap((state) => Stream.fromEffect(discovery.pass(state.value))),
    Stream.runDrain,
  );
});
