import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

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
import { isPenConnectionId, penProfilePin } from "../connection/penPin.ts";
import { routeIsShown } from "../connection/routes.ts";
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
  // A Pen route's id names its member, so a Pen profile also has to be this environment's.
  const penRoutes = new Set(
    removed.flatMap((target) =>
      target._tag === "PenConnectionTarget" ? [penRouteKey(target)] : [],
    ),
  );
  const relayRemoved = removed.some((target) => target._tag === "RelayConnectionTarget");
  const environmentIds = new Set(removed.map((target) => target.environmentId));
  return {
    ...document,
    profiles: document.profiles.filter((value) =>
      value._tag === "PenConnectionProfile"
        ? !penRoutes.has(penRouteKey(value))
        : !connectionIds.has(value.connectionId),
    ),
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
    remoteDpopTokens: relayRemoved
      ? document.remoteDpopTokens.filter((value) => !environmentIds.has(value.environmentId))
      : document.remoteDpopTokens,
  };
}

const penRouteKey = (value: { readonly environmentId: string; readonly connectionId: string }) =>
  `${value.environmentId}\u0000${value.connectionId}`;

// A Pen target and its profile are one record: a target without its own profile, or a second
// target of the same member, is dropped with any profile left without its target.
function pairPenRoutes(document: ConnectionCatalogDocument): ConnectionCatalogDocument {
  const profiles = new Set(
    document.profiles.flatMap((value) =>
      value._tag === "PenConnectionProfile" ? [penRouteKey(value)] : [],
    ),
  );
  const members = new Set<string>();
  const targets = document.targets.filter((target) => {
    if (target._tag !== "PenConnectionTarget") return true;
    if (!profiles.has(penRouteKey(target)) || members.has(target.connectionId)) return false;
    members.add(target.connectionId);
    return true;
  });
  const paired = new Set(
    targets.flatMap((target) =>
      target._tag === "PenConnectionTarget" ? [penRouteKey(target)] : [],
    ),
  );
  return {
    ...document,
    targets,
    profiles: document.profiles.filter(
      (value) => value._tag !== "PenConnectionProfile" || paired.has(penRouteKey(value)),
    ),
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
  // Saved with only routes the closed Pen gate hides, it comes back last and switched on, as a
  // new one does.
  const saved = document.targets.filter((target) => target.environmentId === environmentId);
  const shown = saved.some((target) => routeIsShown({ target }));
  const returning = saved.length > 0 && !shown && routes.some((target) => routeIsShown({ target }));
  const firstIndex = shown
    ? document.targets.findIndex((target) => target.environmentId === environmentId)
    : -1;
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  const next = removeRouteMetadata(document, dropped);
  return {
    ...next,
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
    ...(returning
      ? {
          disabledEnvironmentIds: removeCatalogValue(
            next.disabledEnvironmentIds,
            (value) => value,
            environmentId,
          ),
        }
      : {}),
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
  keep: ReadonlyArray<PersistedConnectionTarget> = [],
): ConnectionCatalogDocument {
  const withoutHub =
    readCatalogHub(document) === environmentId ? setCatalogHub(document, null) : document;
  const next = setRoutesInCatalog(withoutHub, environmentId, keep);
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

// Each hub and Pen record decodes on its own, so one this build cannot read is dropped instead
// of failing the catalog. A record with a readable index keeps its slot until all are placed.
const decodeExtensionRecord = Schema.decodeUnknownOption(
  Schema.Struct({ index: Schema.Number, value: Schema.Unknown }),
);
const extensionRecords = <A>(decode: (value: unknown) => Option.Option<A>, field: unknown) =>
  Array.isArray(field)
    ? field.flatMap((record) =>
        Option.toArray(
          Option.map(decodeExtensionRecord(record), ({ index, value }) => ({
            index,
            value: Option.getOrUndefined(decode(value)),
          })),
        ),
      )
    : [];
// A field that is not a list hides how many slots it held, so nothing is out of range then.
const extensionSlots = (field: unknown) =>
  Array.isArray(field) ? field.length : field === undefined ? 0 : Number.POSITIVE_INFINITY;
// Only a record naming a Pen member is kept: the registry keeps the first route of an id, so a
// Pen record with another route's id would hide that route.
const decodePenTargetValue = Schema.decodeUnknownOption(PenConnectionTarget);
const decodePenProfileValue = Schema.decodeUnknownOption(PenConnectionProfile);
const decodePenTarget = (taken: ReadonlySet<string>) => (value: unknown) =>
  Option.filter(
    decodePenTargetValue(value),
    (target) => isPenConnectionId(target.connectionId) && !taken.has(target.connectionId),
  );
const decodePenProfile = (taken: ReadonlySet<string>) => (value: unknown) =>
  Option.filter(
    decodePenProfileValue(value),
    (profile) => penProfilePin(profile) !== undefined && !taken.has(profile.connectionId),
  );
const encodePenTarget = Schema.encodeSync(PenConnectionTarget);
const encodePenProfile = Schema.encodeSync(PenConnectionProfile);
const decodeHubTarget = Schema.decodeUnknownOption(HubProxyConnectionTarget);
const decodeHubProfile = Schema.decodeUnknownOption(HubProxyConnectionProfile);
const encodeHubTarget = Schema.encodeSync(HubProxyConnectionTarget);
const encodeHubProfile = Schema.encodeSync(HubProxyConnectionProfile);
// Keep legacy arrays readable by older clients: an unknown tagged route would make
// them discard the entire catalog, including unrelated pairing credentials.
const ConnectionCatalogStorageDocument = Schema.Struct({
  ...ConnectionCatalogDocument.fields,
  penTargets: Schema.optionalKey(Schema.Unknown),
  penProfiles: Schema.optionalKey(Schema.Unknown),
  hubProxyTargets: Schema.optionalKey(Schema.Unknown),
  hubProxyProfiles: Schema.optionalKey(Schema.Unknown),
});
const ConnectionCatalogStorageJson = Schema.fromJsonString(ConnectionCatalogStorageDocument);
const decodeStorageDocument = Schema.decodeUnknownEffect(ConnectionCatalogStorageJson);
const encodeStorageDocument = Schema.encodeEffect(ConnectionCatalogStorageJson);

// Hub and Pen records are rediscovered, so one with an unusable position is dropped: failing the
// decode instead would discard the pairing credentials stored beside it.
function mergeExtensions<A>(
  legacy: ReadonlyArray<A | undefined>,
  extensions: ReadonlyArray<{ readonly index: number; readonly value: A | undefined }>,
  dropped: number,
): ReadonlyArray<A | undefined> {
  // Slots of dropped records count, so a record written after one is still in range.
  const total = legacy.length + extensions.length + dropped;
  const usable = extensions
    .map((entry, order) => ({ ...entry, order }))
    .filter(({ index }) => Number.isSafeInteger(index) && index >= 0 && index < total);
  // Records that decoded all stay, sharing an index in stored order as older builds place them; a
  // dropped record's placeholder only takes an index no decoded record claims.
  const claimed = new Set(
    usable.flatMap((entry) => (entry.value === undefined ? [] : [entry.index])),
  );
  const placed = usable
    .filter((entry) => {
      if (entry.value !== undefined) return true;
      if (claimed.has(entry.index)) return false;
      claimed.add(entry.index);
      return true;
    })
    .sort((a, b) => a.index - b.index || a.order - b.order);
  const result: Array<A | undefined> = [...legacy];
  let shared = 0;
  placed.forEach((entry, i) => {
    if (i > 0 && placed[i - 1]?.index === entry.index) shared++;
    result.splice(entry.index + shared, 0, entry.value);
  });
  // Every slot stays until hub and Pen records are both placed: a dropped record holds its own, and
  // one whose position is unknown holds one at the end, so later absolute indexes stay in range.
  // A field that is not a list hides its slot count (Infinity); its records add no slots.
  const unplaced = Number.isFinite(total) ? total - result.length : 0;
  return [...result, ...Array.from({ length: unplaced }, () => undefined)];
}

const present = <A>(values: ReadonlyArray<A | undefined>) =>
  values.filter((value): value is A => value !== undefined);

const isPenRecord = (item: unknown) =>
  typeof item === "object" &&
  item !== null &&
  "_tag" in item &&
  typeof item._tag === "string" &&
  item._tag.startsWith("PenConnection");

// This build stores Pen records only in their own fields. One in the shared lists, from a broken
// or newer writer, is dropped there: the strict lists would otherwise fail the whole catalog. Where
// it stood is kept, so the hub and Pen records placed after it keep their slots.
function withoutSharedPenRecords(raw: string): {
  readonly raw: string;
  readonly dropped: {
    readonly targets: ReadonlyArray<number>;
    readonly profiles: ReadonlyArray<number>;
  };
} {
  const none = { raw, dropped: { targets: [], profiles: [] } };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return none;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return none;
  const lists = value as { targets?: unknown; profiles?: unknown };
  const positions = (field: unknown) =>
    Array.isArray(field) ? field.flatMap((item, index) => (isPenRecord(item) ? [index] : [])) : [];
  const strip = (field: unknown) =>
    Array.isArray(field) ? field.filter((item) => !isPenRecord(item)) : field;
  return {
    raw: JSON.stringify({
      ...lists,
      targets: strip(lists.targets),
      profiles: strip(lists.profiles),
    }),
    dropped: { targets: positions(lists.targets), profiles: positions(lists.profiles) },
  };
}

/** The shared list with an empty slot back where each dropped record stood. */
const withSlots = <A>(values: ReadonlyArray<A>, dropped: ReadonlyArray<number>) => {
  const result: Array<A | undefined> = [...values];
  for (const index of dropped) result.splice(index, 0, undefined);
  return result;
};

const decodeStorageDocumentOption = Schema.decodeUnknownOption(ConnectionCatalogStorageJson);
/** Whether stored text is a catalog this build reads, judged as decodeConnectionCatalogStorage does. */
export const isConnectionCatalogStorage = (raw: string) =>
  Option.isSome(decodeStorageDocumentOption(withoutSharedPenRecords(raw).raw));

export const decodeConnectionCatalogStorage = (raw: string) => {
  const shared = withoutSharedPenRecords(raw);
  return decodeStorageDocument(shared.raw).pipe(
    Effect.map((stored) => {
      const { hubProxyTargets, hubProxyProfiles, penTargets, penProfiles, ...document } = stored;
      // Hub records are placed among what an older client reads, then Pen records among all.
      const hubTargets = extensionRecords(decodeHubTarget, hubProxyTargets);
      const hubProfiles = extensionRecords(decodeHubProfile, hubProxyProfiles);
      const baseTargets = mergeExtensions(
        withSlots(document.targets, shared.dropped.targets),
        hubTargets,
        extensionSlots(hubProxyTargets) - hubTargets.length,
      );
      const baseProfiles = mergeExtensions(
        withSlots(document.profiles, shared.dropped.profiles),
        hubProfiles,
        extensionSlots(hubProxyProfiles) - hubProfiles.length,
      );
      const targets = extensionRecords(
        decodePenTarget(
          new Set(
            present(baseTargets).flatMap((target) =>
              "connectionId" in target ? [target.connectionId] : [],
            ),
          ),
        ),
        penTargets,
      );
      const profiles = extensionRecords(
        decodePenProfile(new Set(present(baseProfiles).map((profile) => profile.connectionId))),
        penProfiles,
      );
      // A hub field that is not a list hides how many slots it held, so no Pen index is too high.
      const unknownHub = (field: unknown) =>
        Number.isFinite(extensionSlots(field)) ? 0 : Infinity;
      return pairPenRoutes({
        ...document,
        targets: present(
          mergeExtensions(
            baseTargets,
            targets,
            extensionSlots(penTargets) - targets.length + unknownHub(hubProxyTargets),
          ),
        ),
        profiles: present(
          mergeExtensions(
            baseProfiles,
            profiles,
            extensionSlots(penProfiles) - profiles.length + unknownHub(hubProxyProfiles),
          ),
        ),
      } satisfies ConnectionCatalogDocument);
    }),
  );
};

export const encodeConnectionCatalogStorage = (document: ConnectionCatalogDocument) => {
  const withoutPen = {
    targets: document.targets.filter((target) => target._tag !== "PenConnectionTarget"),
    profiles: document.profiles.filter((profile) => profile._tag !== "PenConnectionProfile"),
  };
  return encodeStorageDocument({
    ...document,
    targets: document.targets.filter(
      (target) =>
        target._tag !== "HubProxyConnectionTarget" && target._tag !== "PenConnectionTarget",
    ),
    profiles: document.profiles.filter(
      (profile) =>
        profile._tag !== "HubProxyConnectionProfile" && profile._tag !== "PenConnectionProfile",
    ),
    hubProxyTargets: withoutPen.targets.flatMap((value, index) =>
      value._tag === "HubProxyConnectionTarget" ? [{ index, value: encodeHubTarget(value) }] : [],
    ),
    hubProxyProfiles: withoutPen.profiles.flatMap((value, index) =>
      value._tag === "HubProxyConnectionProfile" ? [{ index, value: encodeHubProfile(value) }] : [],
    ),
    penTargets: document.targets.flatMap((value, index) =>
      value._tag === "PenConnectionTarget" ? [{ index, value: encodePenTarget(value) }] : [],
    ),
    penProfiles: document.profiles.flatMap((value, index) =>
      value._tag === "PenConnectionProfile" ? [{ index, value: encodePenProfile(value) }] : [],
    ),
  });
};

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
