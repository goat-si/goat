import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import {
  EnvironmentId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { CloudMachineAlias } from "./cloudMachines.ts";

/**
 * Hub nodes are the machines this GOAT server (the hub) reaches: registered SSH hosts, linked
 * GOAT servers and the cloud machines it owns. The hub owns the list, so a headless
 * `goat serve` serves the same list to every client. A node is one GOAT environment, deduped
 * by environment id, and may be reachable over several routes. Nothing here carries a
 * credential: linked-host tokens stay in the hub's secret store.
 *
 * Later builds add route kinds, statuses and notices. The snapshot drops a node or notice a
 * client cannot decode, so an older client still shows every node it understands.
 */

export const HubNodeRouteKind = Schema.Literals(["ssh", "linked", "cloud"]);
export type HubNodeRouteKind = typeof HubNodeRouteKind.Type;

const OptionalText = Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(255)));

/** The hub dials `alias` with its own ssh; the other fields override the hub's ssh config. */
export const HubNodeSshTarget = Schema.Struct({
  alias: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  hostname: OptionalText,
  username: OptionalText,
  port: Schema.NullOr(PortSchema),
});
export type HubNodeSshTarget = typeof HubNodeSshTarget.Type;

export const HubNodeRouteTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ssh"), ...HubNodeSshTarget.fields }),
  /**
   * A link in the hub's LinkedHosts, by link name. `access` is the ceiling of the hub's MCP
   * session there and `expiresAt` when that session ends; the token itself never leaves the hub.
   */
  Schema.Struct({
    kind: Schema.Literal("linked"),
    name: TrimmedNonEmptyString,
    baseUrl: TrimmedNonEmptyString,
    access: AuthMcpClientAccess,
    expiresAt: IsoDateTime,
  }),
  /** A Boat machine this hub owns. */
  Schema.Struct({ kind: Schema.Literal("cloud"), alias: CloudMachineAlias }),
]);
export type HubNodeRouteTarget = typeof HubNodeRouteTarget.Type;

/**
 * `unknown` until the hub has checked the route. A cloud route reads `offline` while its
 * machine is stopped: checks never wake a machine.
 */
export const HubNodeStatus = Schema.Literals(["online", "offline", "unknown"]);
export type HubNodeStatus = typeof HubNodeStatus.Type;

/** `ssh:<alias>`, `linked:<name>` or `cloud:<alias>`: stable for the life of the route. */
export const HubNodeRouteId = TrimmedNonEmptyString.check(Schema.isMaxLength(300));
export type HubNodeRouteId = typeof HubNodeRouteId.Type;

/** Where a route comes from: a hub registration, a linked host or an owned cloud machine. */
export const HubNodeRouteSource = Schema.Literals(["registered", "linked-host", "cloud-machine"]);
export type HubNodeRouteSource = typeof HubNodeRouteSource.Type;

export const HubNodeRoute = Schema.Struct({
  routeId: HubNodeRouteId,
  source: HubNodeRouteSource,
  target: HubNodeRouteTarget,
  status: HubNodeStatus,
  checkedAt: Schema.NullOr(IsoDateTime),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  /** Why the last check failed, safe to show. */
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});
export type HubNodeRoute = typeof HubNodeRoute.Type;

export const HubNodeAddedBy = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "import"]),
  /** The thread whose agent added it, for an agent GOAT launched. */
  threadId: Schema.optionalKey(ThreadId),
  /** The signed-in outside client's label, for an agent GOAT did not launch. */
  client: Schema.optionalKey(TrimmedNonEmptyString),
  at: IsoDateTime,
});
export type HubNodeAddedBy = typeof HubNodeAddedBy.Type;

/**
 * The node's environment id, or `route:<routeId>` while the hub has not learned it. A node's id
 * changes once its identity is learned; key durable references by `environmentId`. The hub still
 * resolves a `route:<routeId>` id to the node that now holds that route.
 */
export const HubNodeId = TrimmedNonEmptyString.check(Schema.isMaxLength(320));
export type HubNodeId = typeof HubNodeId.Type;

export const HubNode = Schema.Struct({
  nodeId: HubNodeId,
  environmentId: Schema.NullOr(EnvironmentId),
  label: TrimmedNonEmptyString,
  /** `routes[0]`'s kind, for display. It does not say which route works best right now. */
  kind: HubNodeRouteKind,
  /** In fixed order: registered SSH, linked, cloud, then by route id. Never empty. */
  routes: Schema.Array(HubNodeRoute).check(Schema.isMinLength(1)),
  /** `online` when any route is online, `offline` when every checked route is offline. */
  status: HubNodeStatus,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  /** Who registered it; null for a node known only from a linked host or cloud machine. */
  addedBy: Schema.NullOr(HubNodeAddedBy),
});
export type HubNode = typeof HubNode.Type;

export const HubNodeNotice = Schema.Struct({
  /** The desktop's saved connections could not be unlocked, so none were imported. */
  id: Schema.Literal("desktop-import-locked"),
  at: IsoDateTime,
});
export type HubNodeNotice = typeof HubNodeNotice.Type;
export const HubNodeNoticeId = HubNodeNotice.fields.id;

export const HubNodesSnapshot = Schema.Struct({
  hubEnvironmentId: EnvironmentId,
  nodes: ForwardCompatibleArray(HubNode),
  notices: ForwardCompatibleArray(HubNodeNotice),
});
export type HubNodesSnapshot = typeof HubNodesSnapshot.Type;

export const HubNodesListInput = Schema.Struct({});
export type HubNodesListInput = typeof HubNodesListInput.Type;
export const HubNodesSubscribeInput = Schema.Struct({});
export type HubNodesSubscribeInput = typeof HubNodesSubscribeInput.Type;

const NodeLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

export const HubNodesAddInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ssh"),
    ...HubNodeSshTarget.fields,
    label: Schema.optionalKey(NodeLabel),
  }),
  /** Links another GOAT server by spending a pairing code it issued. */
  Schema.Struct({
    kind: Schema.Literal("linked"),
    /** Link name: lowercase letters, digits, ".", "_" and "-". */
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(63)),
    /** The pairing URL, or the server's base URL with `code`. */
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
    code: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
    access: AuthMcpClientAccess,
    label: Schema.optionalKey(NodeLabel),
  }),
]);
export type HubNodesAddInput = typeof HubNodesAddInput.Type;
export const HubNodesAddResult = Schema.Struct({
  /** False when the device was already a node: nothing changed, or it gained this route. */
  created: Schema.Boolean,
  node: HubNode,
});
export type HubNodesAddResult = typeof HubNodesAddResult.Type;

export const HubNodesRemoveInput = Schema.Struct({
  nodeId: HubNodeId,
  /** Remove one route only; omitted removes the node. */
  routeId: Schema.optionalKey(HubNodeRouteId),
});
export type HubNodesRemoveInput = typeof HubNodesRemoveInput.Type;
export const HubNodesRemoveResult = Schema.Struct({
  /** The node as it was before removal. */
  removed: HubNode,
});
export type HubNodesRemoveResult = typeof HubNodesRemoveResult.Type;

export const HubNodesCheckInput = Schema.Struct({
  /** Check one node; omitted checks every node. */
  nodeId: Schema.optionalKey(HubNodeId),
});
export type HubNodesCheckInput = typeof HubNodesCheckInput.Type;

/** One SSH profile from the desktop's saved connections. */
export const HubNodeImportProfile = Schema.Struct({
  environmentId: EnvironmentId,
  label: NodeLabel,
  ssh: HubNodeSshTarget,
});
export type HubNodeImportProfile = typeof HubNodeImportProfile.Type;

export const HubNodesImportInput = Schema.Struct({
  source: Schema.Literal("desktop-catalog"),
  catalog: Schema.Union([
    Schema.Struct({
      state: Schema.Literal("readable"),
      profiles: Schema.Array(HubNodeImportProfile).check(Schema.isMaxLength(500)),
    }),
    Schema.Struct({ state: Schema.Literal("locked") }),
  ]),
});
export type HubNodesImportInput = typeof HubNodesImportInput.Type;
export const HubNodesImportResult = Schema.Struct({
  outcome: Schema.Literals(["imported", "already_imported", "skipped_locked"]),
  imported: NonNegativeInt,
});
export type HubNodesImportResult = typeof HubNodesImportResult.Type;

export const HubNodesDismissNoticeInput = Schema.Struct({ id: HubNodeNoticeId });
export type HubNodesDismissNoticeInput = typeof HubNodesDismissNoticeInput.Type;
export const HubNodesDismissNoticeResult = Schema.Struct({ dismissed: Schema.Boolean });
export type HubNodesDismissNoticeResult = typeof HubNodesDismissNoticeResult.Type;

export const HubNodesErrorReason = Schema.Literals([
  "invalid_request",
  "not_found",
  "refused",
  "host_unavailable",
  "storage_failed",
]);
export type HubNodesErrorReason = typeof HubNodesErrorReason.Type;

/** Safe to show: never carries a token or a raw remote response. */
export class HubNodesError extends Schema.TaggedError<HubNodesError>()("HubNodesError", {
  reason: HubNodesErrorReason,
  detail: Schema.String.check(Schema.isMaxLength(2000)),
}) {
  override get message(): string {
    return this.detail;
  }
}
export const isHubNodesError = Schema.is(HubNodesError);
