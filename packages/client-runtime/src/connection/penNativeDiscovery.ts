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
import { PenConnectionProfile, PenConnectionRegistration } from "./catalog.ts";
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
    const entries = yield* SubscriptionRef.get(registry.entries);
    // Only a route whose target and profile name one member is acted on; another is left as is.
    const existing = [...entries.values()].flatMap(connectionRoutes).flatMap((route) => {
      const profile = Option.getOrUndefined(route.profile);
      const pin = penRoutePin(route.target, profile);
      return pin &&
        route.target._tag === "PenConnectionTarget" &&
        profile?._tag === "PenConnectionProfile"
        ? [{ target: route.target, profile, pin }]
        : [];
    });
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
      if (Option.isSome(gateway))
        yield* gateway.value.close(pin).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close Pen native route", {
              error: redactPenRouteUrl(String(error)),
            }),
          ),
        );
      openedPins.delete(pinKey(pin));
      verified.delete(pinKey(pin));
    }
    for (const [key, pin] of openedPins) {
      if (policy.enabled && Option.isSome(gateway) && penPinIsCurrent(state, pin)) continue;
      if (Option.isSome(gateway))
        yield* gateway.value.close(pin).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close Pen native route", {
              error: redactPenRouteUrl(String(error)),
            }),
          ),
        );
      openedPins.delete(key);
    }
    if (!policy.enabled || Option.isNone(gateway) || state.kind !== "ready") return;
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
          const opened = yield* activeGateway.open(pin).pipe(Effect.uninterruptible);
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
          Effect.catch((error) =>
            Effect.logDebug("Pen native route discovery failed", {
              error: redactPenRouteUrl(String(error)),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });
  return { pass };
});

export const watchPenNativeDiscovery = Effect.gen(function* () {
  const membership = yield* PenMembership;
  const { pass } = yield* makePenNativeDiscovery();
  yield* SubscriptionRef.changes(membership.latest).pipe(
    Stream.filter(Option.isSome),
    Stream.switchMap((state) => Stream.fromEffect(pass(state.value))),
    Stream.runDrain,
  );
});
