import type { DesktopPenPin } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/http";
import { appendClientConnectionParams } from "../authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import {
  ClientPresentation,
  PenRouteGateway,
  PenViewerPolicy,
  type PenMembersInput,
} from "../platform/capabilities.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  penConnectionId,
  type PreparedConnection,
} from "./model.ts";
import { PenMembership } from "./penMembership.ts";

export const penPinIsCurrent = (state: PenMembersInput, pin: DesktopPenPin): boolean =>
  state.kind === "ready" &&
  state.meshId === pin.meshId &&
  state.selfNodeId !== pin.nodeId &&
  state.members.some((member) => member.nodeId === pin.nodeId && member.noisePub === pin.noisePub);

export const makePenRouteBroker = Effect.fn("PenRouteBroker.make")(function* () {
  const policy = yield* PenViewerPolicy;
  const gateway = yield* PenRouteGateway;
  const membership = yield* PenMembership;
  const presentation = yield* ClientPresentation;
  return Effect.fn("PenRouteBroker.prepare")(function* (entry: ConnectionCatalogEntry) {
    const target = entry.target;
    const profile = Option.getOrUndefined(entry.profile);
    if (
      !policy.enabled ||
      Option.isNone(gateway) ||
      target._tag !== "PenConnectionTarget" ||
      profile?._tag !== "PenConnectionProfile" ||
      profile.connectionId !== target.connectionId ||
      profile.environmentId !== target.environmentId ||
      profile.connectionId !== penConnectionId(profile.meshId, profile.nodeId)
    )
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Pen route is unavailable or its profile does not match.",
      });
    const pin = { meshId: profile.meshId, nodeId: profile.nodeId, noisePub: profile.noisePub };
    const latest = yield* SubscriptionRef.get(membership.latest);
    if (Option.isNone(latest) || latest.value.kind === "unavailable")
      return yield* new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "Pen is not running here, so its member list cannot be confirmed.",
      });
    if (!penPinIsCurrent(latest.value, pin))
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "That machine is no longer a Pen member with this key.",
      });
    const route = yield* gateway.value.open(pin);
    if (route.kind === "refused") {
      const detail = `Pen route refused: ${route.reason}.`;
      return yield* route.reason === "busy" || route.reason === "unavailable"
        ? new ConnectionTransientError({ reason: "remote-unavailable", detail })
        : new ConnectionBlockedError({ reason: "configuration", detail });
    }
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: route.httpBaseUrl,
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "omit",
        cache: "no-store",
      }),
      Effect.mapError(mapRemoteEnvironmentError),
    );
    if (descriptor.environmentId !== target.environmentId)
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    const socket = new URL(route.socketUrl);
    socket.search = "";
    appendClientConnectionParams(socket, presentation.metadata, "direct");
    return {
      descriptor,
      prepared: {
        target,
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: route.httpBaseUrl,
        socketUrl: socket.toString(),
        httpAuthorization: null,
      } satisfies PreparedConnection,
    };
  });
});
