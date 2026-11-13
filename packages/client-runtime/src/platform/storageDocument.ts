import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
  HubProxyConnectionProfile,
  PenConnectionProfile,
} from "../connection/catalog.ts";
import {
  HubProxyConnectionTarget,
  PenConnectionTarget,
  type ConnectionTarget,
  PersistedConnectionTarget,
} from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  hub: Schema.optionalKey(Schema.Struct({ environmentId: EnvironmentId })),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  // Pull request routing grants. The field name predates the rename and stays, so older and
  // newer clients sharing this document keep reading and revoking the same grants.
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});

export function readCatalogHub(document: ConnectionCatalogDocument): EnvironmentId | null {
  return document.hub?.environmentId ?? null;
}

export function setCatalogHub(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId | null,
): ConnectionCatalogDocument {
  if (environmentId === null) {
    const { hub: _hub, ...rest } = document;
    return rest;
  }
  return { ...document, hub: { environmentId } };
}

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

export function putConnectionCredentialInCatalog(
  document: ConnectionCatalogDocument,
  connectionId: string,
  credential: StoredConnectionCredential["credential"],
  expectedToken?: string | null,
): ConnectionCatalogDocument {
  const current = document.credentials.find((value) => value.connectionId === connectionId);
  if (expectedToken !== undefined && (current?.credential.token ?? null) !== expectedToken)
    return document;
  // A reconnect can finish after another window forgot this SSH route.
  if (
    connectionId.startsWith("ssh:") &&
    !document.targets.some(
      (target) => target._tag === "SshConnectionTarget" && target.connectionId === connectionId,
    )
  )
    return document;
  return {
    ...document,
    credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
      connectionId,
      credential,
    }),
  };
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
    case "HubProxyConnectionTarget":
    case "PenConnectionTarget":
      return target.connectionId;
  }
}

function routeKey(target: ConnectionTarget): string {
  return connectionIdOf(target) ?? target._tag;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  const relayRemoved = removed.some((target) => target._tag === "RelayConnectionTarget");
  const environmentIds = new Set(removed.map((target) => target.environmentId));
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
    remoteDpopTokens: relayRemoved
      ? document.remoteDpopTokens.filter((value) => !environmentIds.has(value.environmentId))
      : document.remoteDpopTokens,
  };
}

export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Records owned by a dropped route go with it; the environment keeps its
 * position in the catalog. An empty list leaves the environment's other records
 * in place; use `removeConnectionFromCatalog` to forget the environment.
 */
export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(routeKey));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(routeKey(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, registration.target.environmentId, routes);

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "HubProxyConnectionRegistration":
    case "PenConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
        }),
      };
  }
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const withoutHub =
    readCatalogHub(document) === environmentId ? setCatalogHub(document, null) : document;
  const next = setRoutesInCatalog(withoutHub, environmentId, []);
  return {
    ...next,
    remoteDpopTokens: removeCatalogValue(
      next.remoteDpopTokens,
      (value) => value.environmentId,
      environmentId,
    ),
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}

export function putRemoteDpopTokenInCatalog(
  document: ConnectionCatalogDocument,
  token: TokenStore.RemoteDpopAccessToken,
): ConnectionCatalogDocument {
  const registered = document.targets.some(
    (target) =>
      target._tag === "RelayConnectionTarget" && target.environmentId === token.environmentId,
  );
  if (!registered) {
    return document;
  }
  return {
    ...document,
    remoteDpopTokens: replaceCatalogValue(
      document.remoteDpopTokens,
      (value) => value.environmentId,
      token,
    ),
  };
}

// Keep legacy arrays readable by older clients: an unknown tagged route would make
// them discard the entire catalog, including unrelated pairing credentials.
const ConnectionCatalogStorageDocument = Schema.Struct({
  ...ConnectionCatalogDocument.fields,
  penTargets: Schema.optionalKey(
    Schema.Array(Schema.Struct({ index: Schema.Number, value: PenConnectionTarget })),
  ),
  penProfiles: Schema.optionalKey(
    Schema.Array(Schema.Struct({ index: Schema.Number, value: PenConnectionProfile })),
  ),
  hubProxyTargets: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        value: HubProxyConnectionTarget,
      }),
    ),
  ),
  hubProxyProfiles: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        value: HubProxyConnectionProfile,
      }),
    ),
  ),
});
const ConnectionCatalogStorageJson = Schema.fromJsonString(ConnectionCatalogStorageDocument);
const decodeStorageDocument = Schema.decodeUnknownEffect(ConnectionCatalogStorageJson);
const encodeStorageDocument = Schema.encodeEffect(ConnectionCatalogStorageJson);

// Hub and Pen records are rediscovered, so one with an unusable position is dropped: failing the
// decode instead would discard the pairing credentials stored beside it.
function mergeExtensions<A>(
  legacy: ReadonlyArray<A>,
  extensions: ReadonlyArray<{ readonly index: number; readonly value: A }>,
): ReadonlyArray<A> {
  const total = legacy.length + extensions.length;
  const seen = new Set<number>();
  const placed = extensions
    .filter(({ index }) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= total || seen.has(index))
        return false;
      seen.add(index);
      return true;
    })
    .sort((a, b) => a.index - b.index);
  const result = [...legacy];
  for (const entry of placed) result.splice(entry.index, 0, entry.value);
  return result;
}

export const decodeConnectionCatalogStorage = (raw: string) =>
  decodeStorageDocument(raw).pipe(
    Effect.map((stored) => {
      const { hubProxyTargets, hubProxyProfiles, penTargets, penProfiles, ...document } = stored;
      const targets = mergeExtensions(document.targets, [
        ...(hubProxyTargets ?? []),
        ...(penTargets ?? []),
      ]);
      const profiles = mergeExtensions(document.profiles, [
        ...(hubProxyProfiles ?? []),
        ...(penProfiles ?? []),
      ]);
      return { ...document, targets, profiles } satisfies ConnectionCatalogDocument;
    }),
  );

export const encodeConnectionCatalogStorage = (document: ConnectionCatalogDocument) =>
  encodeStorageDocument({
    ...document,
    targets: document.targets.filter(
      (target) =>
        target._tag !== "HubProxyConnectionTarget" && target._tag !== "PenConnectionTarget",
    ),
    profiles: document.profiles.filter(
      (profile) =>
        profile._tag !== "HubProxyConnectionProfile" && profile._tag !== "PenConnectionProfile",
    ),
    hubProxyTargets: document.targets.flatMap((value, index) =>
      value._tag === "HubProxyConnectionTarget" ? [{ index, value }] : [],
    ),
    hubProxyProfiles: document.profiles.flatMap((value, index) =>
      value._tag === "HubProxyConnectionProfile" ? [{ index, value }] : [],
    ),
    penTargets: document.targets.flatMap((value, index) =>
      value._tag === "PenConnectionTarget" ? [{ index, value }] : [],
    ),
    penProfiles: document.profiles.flatMap((value, index) =>
      value._tag === "PenConnectionProfile" ? [{ index, value }] : [],
    ),
  });

export function isFutureConnectionCatalog(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return (
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value &&
      typeof value.schemaVersion === "number" &&
      value.schemaVersion > 1
    );
  } catch {
    return false;
  }
}
