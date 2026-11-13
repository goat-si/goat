import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { needsHumanFields } from "./humanStepResult.ts";

const Alias = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
/** OpenCodex takes a route alias up to 253 characters; the server checks its form. */
const RouteAlias = TrimmedNonEmptyString.check(Schema.isMaxLength(253));

/**
 * One edit to a Remote Link Child's SSH routes on the Home, as `ocx link routes` takes it. The
 * link's own alias is its pinned host-key name; OpenCodex keeps it in the list and refuses to
 * remove it. An added route is stored only after it proved that pinned key over itself.
 */
export const HubDeviceRoutesChange = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("add"),
    route: RouteAlias,
    position: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 }))),
  }),
  Schema.Struct({ op: Schema.Literal("remove"), route: RouteAlias }),
  Schema.Struct({
    op: Schema.Literal("order"),
    routes: Schema.Array(RouteAlias).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
]);
export type HubDeviceRoutesChange = typeof HubDeviceRoutesChange.Type;

export const HubDeviceRoutesInput = Schema.Struct({ deviceAlias: Alias });
export type HubDeviceRoutesInput = typeof HubDeviceRoutesInput.Type;

export const HubDeviceRoutesUpdateInput = Schema.Struct({
  deviceAlias: Alias,
  change: HubDeviceRoutesChange,
  /** An answered decision from an earlier call for this exact change; it is consumed once. */
  decisionId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
});
export type HubDeviceRoutesUpdateInput = typeof HubDeviceRoutesUpdateInput.Type;

/**
 * unsupported: no `ocx link routes` on the Home. code: OpenCodex's fixed refusal word, or GOAT's
 * for a failure before ocx starts (ocx_missing, ocx_unstartable, link_status_unreadable,
 * this_machine_is_child, link_not_found); a failed answer with a code changed nothing and leaves an
 * approval unspent. cause: OpenCodex's class word such as transient, never its free text.
 */
export const HubDeviceRoutesResult = Schema.Struct({
  deviceAlias: Schema.String,
  state: Schema.Literals(["ok", "needs_human", "failed", "unsupported"]),
  message: Schema.String,
  linkId: Schema.optional(Schema.String),
  /** The link's pinned alias; always one of routes. */
  pin: Schema.optional(Schema.String),
  /** The routes in the order the Home tries them. */
  routes: Schema.optional(Schema.Array(Schema.String)),
  /** The link's one route is fixed at enrollment; OpenCodex refuses every edit. */
  exclusive: Schema.optional(Schema.Literal(true)),
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.String),
  decisionId: Schema.optional(Schema.String),
});
export type HubDeviceRoutesResult = typeof HubDeviceRoutesResult.Type;

/** What goat_hub_device_routes_update returns; its needs_human names itself as the next call. */
export const HubDeviceRoutesUpdateResult = Schema.Union([
  Schema.Struct({
    ...HubDeviceRoutesResult.fields,
    state: Schema.Literal("needs_human"),
    decisionId: Schema.String,
    ...needsHumanFields("approval", "goat_hub_device_routes_update"),
  }),
  HubDeviceRoutesResult,
]);
export type HubDeviceRoutesUpdateResult = typeof HubDeviceRoutesUpdateResult.Type;
