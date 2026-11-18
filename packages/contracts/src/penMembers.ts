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
export interface DesktopPenBridge {
  getPenMembers?: () => Promise<DesktopPenMembersState>;
  onPenMembersChanged?: (listener: (state: DesktopPenMembersState) => void) => () => void;
  issuePenMemberSession?: (
    target: DesktopSshEnvironmentTarget,
    penNodeId: typeof PenId.Type,
  ) => Promise<DesktopPenMemberSessionResult>;
}
