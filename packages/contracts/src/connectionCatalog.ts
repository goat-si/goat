import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { LEGACY_CONNECT_ROUTE_KIND } from "./legacyT3Names.ts";

/**
 * Legacy desktop catalog bridge. The hub owns agent-managed nodes; after hub mutations the
 * server forwards operations to an attached desktop renderer over `connectionCatalog.serve`
 * and waits for `connectionCatalog.respond` to keep its saved sidebar connections in sync.
 */

/** Who saved a connection on the user's behalf. */
export const ConnectionAddedBy = Schema.Struct({
  kind: Schema.Literal("agent"),
  /** The thread whose agent called the tool, for an agent GOAT launched. */
  threadId: Schema.optionalKey(ThreadId),
  /** The signed-in outside client's label, for an agent GOAT did not launch. */
  client: Schema.optionalKey(TrimmedNonEmptyString),
  at: IsoDateTime,
});
export type ConnectionAddedBy = typeof ConnectionAddedBy.Type;

/** One way the client reaches a saved environment. Never carries credentials. */
export const SavedConnectionRoute = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ssh"),
    host: Schema.String,
    hostname: Schema.String,
    username: Schema.NullOr(Schema.String),
    port: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("direct"), httpBaseUrl: Schema.String }),
  Schema.Struct({ kind: Schema.Literal(LEGACY_CONNECT_ROUTE_KIND) }),
  /** Through another environment acting as the hub; the hub holds the node's session. */
  Schema.Struct({
    kind: Schema.Literal("hub-proxy"),
    hubEnvironmentId: EnvironmentId,
    nodeId: Schema.String,
  }),
]);
export type SavedConnectionRoute = typeof SavedConnectionRoute.Type;

export const SavedConnection = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** False when the user switched it off in Settings: saved, but not connected. */
  enabled: Schema.Boolean,
  /** Preferred route first. */
  routes: Schema.Array(SavedConnectionRoute),
  addedBy: Schema.optionalKey(ConnectionAddedBy),
});
export type SavedConnection = typeof SavedConnection.Type;

export const ConnectionCatalogOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list") }),
  Schema.Struct({
    type: Schema.Literal("add_ssh"),
    /** An SSH alias or host this machine's ssh resolves. */
    host: TrimmedNonEmptyString,
    label: Schema.optionalKey(TrimmedNonEmptyString),
    addedBy: ConnectionAddedBy,
  }),
  Schema.Struct({ type: Schema.Literal("remove"), environmentId: EnvironmentId }),
]);
export type ConnectionCatalogOperation = typeof ConnectionCatalogOperation.Type;

export const ConnectionCatalogRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type ConnectionCatalogRequestId = typeof ConnectionCatalogRequestId.Type;

/** An operation the server asks the desktop renderer to run. */
export const ConnectionCatalogHostRequest = Schema.Struct({
  requestId: ConnectionCatalogRequestId,
  expiresAt: IsoDateTime,
  operation: ConnectionCatalogOperation,
});
export type ConnectionCatalogHostRequest = typeof ConnectionCatalogHostRequest.Type;

export const ConnectionCatalogFailureReason = Schema.Literals([
  "invalid_request",
  "not_found",
  "refused",
  "connection_failed",
]);
export type ConnectionCatalogFailureReason = typeof ConnectionCatalogFailureReason.Type;

export const ConnectionCatalogResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list"), connections: Schema.Array(SavedConnection) }),
  Schema.Struct({
    type: Schema.Literal("add_ssh"),
    /** False when the machine was already saved: nothing changed, or an SSH route was added to it. */
    created: Schema.Boolean,
    connection: SavedConnection,
  }),
  Schema.Struct({ type: Schema.Literal("remove"), removed: SavedConnection }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    reason: ConnectionCatalogFailureReason,
    message: Schema.String.check(Schema.isMaxLength(2000)),
  }),
]);
export type ConnectionCatalogResult = typeof ConnectionCatalogResult.Type;

export const ConnectionCatalogHostResponse = Schema.Struct({
  requestId: ConnectionCatalogRequestId,
  result: ConnectionCatalogResult,
});
export type ConnectionCatalogHostResponse = typeof ConnectionCatalogHostResponse.Type;
