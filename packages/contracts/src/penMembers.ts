import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import {
  DesktopSshEnvironmentTargetSchema,
  type DesktopSshEnvironmentTarget,
} from "./desktopSshTarget.ts";
import { PenId } from "./penSettings.ts";

export const PenRouteRefusal = Schema.Literals([
  "not-in-pen-config",
  "not-pen-route",
  "node-mismatch",
  "known-hosts-not-pen",
  "global-known-hosts",
  "no-recorded-key",
  "marker-lines",
  "key-mismatch",
  "unreadable",
]);
export type PenRouteRefusal = typeof PenRouteRefusal.Type;

export const DesktopPenMember = Schema.Struct({
  nodeId: PenId,
  name: Schema.String.check(Schema.isMaxLength(64)),
  online: Schema.Boolean,
  noisePub: Schema.String.check(Schema.isMaxLength(128)),
  route: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("trusted"),
      target: DesktopSshEnvironmentTargetSchema,
      revision: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("refused"), reason: PenRouteRefusal }),
  ]),
});
export type DesktopPenMember = typeof DesktopPenMember.Type;

export const DesktopPenMembersState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    seq: NonNegativeInt,
    reason: Schema.Literals(["no-pen", "daemon-down", "stale"]),
  }),
  Schema.Struct({ kind: Schema.Literal("not-member"), seq: NonNegativeInt }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    seq: NonNegativeInt,
    meshId: PenId,
    selfNodeId: PenId,
    members: Schema.Array(DesktopPenMember),
  }),
]);
export type DesktopPenMembersState = typeof DesktopPenMembersState.Type;

export const DesktopPenMemberSessionInputSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  penNodeId: PenId,
});
export const DesktopPenMemberSessionResultSchema = Schema.Struct({
  accessToken: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});
export type DesktopPenMemberSessionResult = typeof DesktopPenMemberSessionResultSchema.Type;

export const penEnsureOptionFields = {
  installation: Schema.optionalKey(Schema.Literal("existing-only")),
  penNodeId: Schema.optionalKey(PenId),
};
export type DesktopPenEnsureOptions = {
  installation?: "existing-only";
  penNodeId?: typeof PenId.Type;
};

/** What a Pen-native route pins: the mesh, the member and the Noise key the dial must reach. */
export const DesktopPenPinSchema = Schema.Struct({
  meshId: PenId,
  nodeId: PenId,
  noisePub: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
});
export type DesktopPenPin = typeof DesktopPenPinSchema.Type;

export const DesktopPenRouteResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("open"),
    httpBaseUrl: Schema.String,
    socketUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["not-member", "unavailable", "no-pen-binary", "busy"]),
  }),
]);
export type DesktopPenRouteResult = typeof DesktopPenRouteResultSchema.Type;

/** cancelled: the person closed the dialog. failed: Pen refused, or the outcome is unknown. */
export const DesktopPenRevokeResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("cancelled") }),
  Schema.Struct({ status: Schema.Literal("revoked"), output: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
]);
export type DesktopPenRevokeResult = typeof DesktopPenRevokeResultSchema.Type;

export interface DesktopPenBridge {
  getPenMembers?: () => Promise<DesktopPenMembersState>;
  onPenMembersChanged?: (listener: (state: DesktopPenMembersState) => void) => () => void;
  issuePenMemberSession?: (
    target: DesktopSshEnvironmentTarget,
    penNodeId: typeof PenId.Type,
  ) => Promise<DesktopPenMemberSessionResult>;
  /** Opens, or returns, this computer's loopback route to a member's GOAT. One route per pin. */
  openPenRoute?: (pin: DesktopPenPin) => Promise<DesktopPenRouteResult>;
  closePenRoute?: (pin: DesktopPenPin) => Promise<void>;
  /** Asks the person in a native dialog, then removes that member from the Pen mesh. */
  revokePenMember?: (pin: DesktopPenPin) => Promise<DesktopPenRevokeResult>;
}
