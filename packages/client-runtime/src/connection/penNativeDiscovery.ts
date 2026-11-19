import type { DesktopPenMembersState, DesktopPenPin } from "@goat/contracts";
import { redactPenRouteUrl } from "@goat/shared/penRouteUrl";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/http";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import {
  PenRouteGateway,
  PenViewerPolicy,
  type PenMembersInput,
} from "../platform/capabilities.ts";
import {
  PenConnectionProfile,
  PenConnectionRegistration,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import { penConnectionId, PenConnectionTarget } from "./model.ts";
import { PenMembership } from "./penMembership.ts";
import { penRoutePin } from "./penPin.ts";
import { penPinIsCurrent } from "./penRouteBroker.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { connectionRoutes } from "./routes.ts";

// An offline member's dial only times out; its next online change is a new state and a new pass.
export const nativePenCandidates = (state: Extract<DesktopPenMembersState, { kind: "ready" }>) =>
  state.members.filter((member) => member.online && member.nodeId !== state.selfNodeId);

const pinKey = (pin: DesktopPenPin) => `${pin.meshId}:${pin.nodeId}:${pin.noisePub}`;

// A member Pen still lists, under any key: a new Noise key is not a departure.
const memberListed = (state: PenMembersInput, pin: DesktopPenPin) =>
  state.kind === "ready" &&
  state.meshId === pin.meshId &&
  state.selfNodeId !== pin.nodeId &&
  state.members.some((member) => member.nodeId === pin.nodeId);

// Only a route whose target and profile name one member is acted on; another is left as is.
const storedPenRoutes = (entries: ReadonlyMap<unknown, ConnectionCatalogEntry>) =>
  [...entries.values()].flatMap(connectionRoutes).flatMap((route) => {
    const profile = Option.getOrUndefined(route.profile);
    const pin = penRoutePin(route.target, profile);
    return pin &&
      route.target._tag === "PenConnectionTarget" &&
      profile?._tag === "PenConnectionProfile"
      ? [{ target: route.target, profile, pin }]
      : [];
  });

export const makePenNativeDiscovery = Effect.fn("PenNativeDiscovery.make")(function* () {
  const membership = yield* PenMembership;
  const registry = yield* EnvironmentRegistry;
  const policy = yield* PenViewerPolicy;
  const gateway = yield* PenRouteGateway;
  const openedPins = new Map<string, DesktopPenPin>();
  // A stored route is read once per run: the member's GOAT may have a new environment id since.
  const verified = new Set<string>();
  const pass = Effect.fn("PenNativeDiscovery.pass")(function* (state: PenMembersInput) {
    if (state.kind === "unavailable" && policy.enabled && Option.isSome(gateway)) return;
    const existing = storedPenRoutes(yield* SubscriptionRef.get(registry.entries));
    const closed = new Set<string>();
    for (const route of existing) {
      const { pin } = route;
      // Only a member Pen says left loses its route, and only where the viewer runs: removing an
      // environment's last route deletes it with its drafts. A closed gate, Pen machines turned
      // off, a client without the gateway or a member's new key leave the route stored.
      const left =
        policy.enabled &&
        Option.isSome(gateway) &&
        (state.kind === "not-member" || (state.kind === "ready" && !memberListed(state, pin)));
      if (!left) continue;
      yield* registry.removeRoute(route.target.environmentId, route.target.connectionId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove Pen native route", {
            error: redactPenRouteUrl(String(error)),
          }),
        ),
      );
      yield* closeLink(pin);
      closed.add(pinKey(pin));
    }
    // A member the newest state does not list (or Pen machines switched off) loses its link,
    // whether discovery or a connection opened it, and is checked again when it returns.
    const links = new Map(openedPins);
    for (const { pin } of existing) links.set(pinKey(pin), pin);
    for (const [key, pin] of links) {
      if (closed.has(key)) continue;
      if (policy.enabled && Option.isSome(gateway) && penPinIsCurrent(state, pin)) continue;
      yield* closeLink(pin);
    }
    if (!policy.enabled || Option.isNone(gateway) || state.kind !== "ready") return;
    // A machine blocked while its member was gone (or Pen machines were off) tries again now.
    for (const { target, pin } of existing) {
      if (!penPinIsCurrent(state, pin)) continue;
      const current = yield* registry.state(target.environmentId).pipe(Effect.option);
      const failure = Option.getOrUndefined(current)?.lastFailure;
      if (
        Option.getOrUndefined(current)?.phase === "blocked" &&
        failure?._tag === "ConnectionBlockedError" &&
        failure.reason === "configuration"
      )
        yield* registry.retryNow(target.environmentId);
    }
    const activeGateway = gateway.value;
    yield* Effect.forEach(
      nativePenCandidates(state),
      (member) =>
        Effect.gen(function* () {
          const pin = { meshId: state.meshId, nodeId: member.nodeId, noisePub: member.noisePub };
          const connectionId = penConnectionId(pin.meshId, pin.nodeId);
          const known = existing.find((route) => route.profile.connectionId === connectionId);
          const sameKey = known?.pin.noisePub === pin.noisePub;
          if (sameKey && verified.has(pinKey(pin))) return;
          const latestBeforeOpen = yield* SubscriptionRef.get(membership.latest);
          if (Option.isNone(latestBeforeOpen) || !penPinIsCurrent(latestBeforeOpen.value, pin))
            return;
          openedPins.set(pinKey(pin), pin);
          // However this ends, a link no saved route holds afterwards is given back.
          const opened = yield* Effect.acquireRelease(activeGateway.open(pin), () =>
            releaseUnheld(pin),
          );
          if (opened.kind !== "open") return;
          const descriptor = yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: opened.httpBaseUrl,
          }).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, {
              credentials: "omit",
              cache: "no-store",
            }),
          );
          const latest = yield* SubscriptionRef.get(membership.latest);
          if (Option.isNone(latest) || !penPinIsCurrent(latest.value, pin)) return;
          if (known !== undefined) {
            if (known.target.environmentId === descriptor.environmentId && sameKey) {
              verified.add(pinKey(pin));
              return;
            }
            // Another environment behind the same member keeps the saved one, its drafts and
            // route; the person removes it to take the new one. A new key updates it in place.
            if (known.target.environmentId !== descriptor.environmentId) {
              verified.add(pinKey(pin));
              return yield* Effect.logInfo("A Pen member answers as another environment", {
                saved: known.target.environmentId,
                answered: descriptor.environmentId,
              });
            }
          }
          const target = new PenConnectionTarget({
            connectionId,
            environmentId: descriptor.environmentId,
            label: member.name,
          });
          yield* registry.register(
            new PenConnectionRegistration({
              target,
              profile: new PenConnectionProfile({
                ...pin,
                connectionId,
                environmentId: descriptor.environmentId,
                label: member.name,
              }),
            }),
          );
          verified.add(pinKey(pin));
        }).pipe(
          Effect.scoped,
          Effect.catch((error) =>
            Effect.logDebug("Pen native route discovery failed", {
              error: redactPenRouteUrl(String(error)),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });
  const closeLink = (pin: DesktopPenPin) => {
    openedPins.delete(pinKey(pin));
    verified.delete(pinKey(pin));
    return Option.isNone(gateway)
      ? Effect.void
      : gateway.value.close(pin).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close Pen native route", {
              error: redactPenRouteUrl(String(error)),
            }),
          ),
        );
  };
  const releaseUnheld = (pin: DesktopPenPin) =>
    SubscriptionRef.get(registry.entries).pipe(
      Effect.flatMap((entries) =>
        storedPenRoutes(entries).some((route) => pinKey(route.pin) === pinKey(pin))
          ? Effect.void
          : closeLink(pin),
      ),
    );
  // A link no saved route holds any more (its environment or route was removed) is closed,
  // whether discovery or a connection opened it.
  let held = new Map<string, DesktopPenPin>();
  const release = Effect.fn("PenNativeDiscovery.release")(function* (
    entries: ReadonlyMap<unknown, ConnectionCatalogEntry>,
  ) {
    const now = new Map(storedPenRoutes(entries).map(({ pin }) => [pinKey(pin), pin]));
    for (const [key, pin] of held) if (!now.has(key)) yield* closeLink(pin);
    held = now;
  });
  return { pass, release };
});

export const watchPenNativeDiscovery = Effect.gen(function* () {
  const membership = yield* PenMembership;
  const registry = yield* EnvironmentRegistry;
  const { pass, release } = yield* makePenNativeDiscovery();
  yield* Effect.all(
    [
      SubscriptionRef.changes(membership.latest).pipe(
        Stream.filter(Option.isSome),
        Stream.switchMap((state) => Stream.fromEffect(pass(state.value))),
        Stream.runDrain,
      ),
      SubscriptionRef.changes(registry.entries).pipe(Stream.runForEach(release)),
    ],
    { concurrency: "unbounded", discard: true },
  );
});
