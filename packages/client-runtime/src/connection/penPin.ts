import { DesktopPenPinSchema, type DesktopPenPin } from "@goat/contracts";
import * as Schema from "effect/Schema";
import type { ConnectionProfile } from "./catalog.ts";
import { penConnectionId, type ConnectionTarget } from "./model.ts";

const isPin = Schema.is(DesktopPenPinSchema);

/** A Pen route's id is pen:<mesh>:<node>, a form no other kind of route uses. */
export const isPenConnectionId = (connectionId: string) =>
  /^pen:[a-z2-7]{26}:[a-z2-7]{26}$/u.test(connectionId);

/** The member a Pen profile pins, when its fields name one and its id is that member's. */
export const penProfilePin = (profile: ConnectionProfile): DesktopPenPin | undefined => {
  if (profile._tag !== "PenConnectionProfile") return undefined;
  const pin = { meshId: profile.meshId, nodeId: profile.nodeId, noisePub: profile.noisePub };
  return isPin(pin) && profile.connectionId === penConnectionId(pin.meshId, pin.nodeId)
    ? pin
    : undefined;
};

/** The pin of a Pen route whose target and profile agree on one environment and member. */
export const penRoutePin = (
  target: ConnectionTarget,
  profile: ConnectionProfile | undefined,
): DesktopPenPin | undefined =>
  target._tag === "PenConnectionTarget" &&
  profile !== undefined &&
  profile.connectionId === target.connectionId &&
  profile.environmentId === target.environmentId
    ? penProfilePin(profile)
    : undefined;
